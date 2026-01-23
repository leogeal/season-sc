// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "./SeasonVault.sol";
import "./mocks/MockDex.sol";

contract SeasonRebalancer is Ownable {
    using Math for uint256;

    uint256 public constant NUM_TOKENS = 4;
    uint256 public constant BPS_DENOM = 10_000;

    uint256 public rebalanceNonce;

    SeasonVault public immutable vault;
    MockDex public immutable dex;

    // weights in bps for each token index 0..3
    uint16[4] public weightsBps;

    // max slippage tolerance for MockDex quotes (bps)
    uint16 public maxSlippageBps;

    // Guardrails
    uint16 public maxTradeBps;        // per-token trade budget per rebalance, in bps of starting balance (0..10000)
    uint32 public cooldownSeconds;    // minimum seconds between rebalances
    uint256 public lastRebalanceTs;   // last rebalance timestamp
    uint8 public maxSwapsPerRebalance; // 0 = unlimited
    uint256 public minTradeAmount; // minimum amountIn to execute a swap (applies to all tokens)
    uint16 public minDriftBps; // minimum max deviation (in bps) required to perform swaps

    event Rebalanced(uint256[4] beforeBals, uint256[4] afterBals);
    event WeightsUpdated(uint16[4] weightsBps);
    event MaxSlippageUpdated(uint16 maxSlippageBps);
    event RebalanceStarted(uint256 indexed nonce, uint256 totalBefore, uint256[4] beforeBals);
    event SwapExecuted(
	uint256 indexed nonce,
	address indexed tokenIn,
	address indexed tokenOut,
	uint256 amountIn,
	uint256 quotedOut,
	uint256 minOut,
	uint256 amountOut
    );
    event RebalanceFinished(uint256 indexed nonce, uint256 totalAfter, uint256[4] afterBals);
    event MaxTradeBpsUpdated(uint16 maxTradeBps);
    event CooldownSecondsUpdated(uint32 cooldownSeconds);
    event MaxSwapsPerRebalanceUpdated(uint8 maxSwapsPerRebalance);
    event MinTradeAmountUpdated(uint256 minTradeAmount);
    event MinDriftBpsUpdated(uint16 minDriftBps);
    event RebalanceSkipped(
	uint256 indexed nonce,
	uint16 maxDriftBps,
	uint16[4] currentWeightsBps,
	uint16[4] targetWeightsBps
    );

    constructor(address vaultAddr, address dexAddr, address initialOwner)
        Ownable(initialOwner)
    {
	maxTradeBps = 10_000;      // default: no cap
        cooldownSeconds = 0;       // default: no cooldown
	maxSwapsPerRebalance = 0; // default: unlimited
	minTradeAmount = 0; // default: no minimum (execute all)
	minDriftBps = 0; // default: always allow rebalances

        vault = SeasonVault(vaultAddr);
        dex = MockDex(dexAddr);

        // Default equal weights
        weightsBps = [uint16(2500), uint16(2500), uint16(2500), uint16(2500)];
        maxSlippageBps = 50; // 0.50%
    }

    function setWeights(uint16[4] calldata w) external onlyOwner {
        uint256 sum;
        for (uint256 i = 0; i < 4; i++) sum += w[i];
        require(sum == BPS_DENOM, "WEIGHTS_NOT_100%");
        weightsBps = [w[0], w[1], w[2], w[3]];
        emit WeightsUpdated(weightsBps);
    }

    function setMaxSlippageBps(uint16 bps) external onlyOwner {
        require(bps <= 1000, "SLIPPAGE_TOO_HIGH"); // <= 10%
        maxSlippageBps = bps;
        emit MaxSlippageUpdated(bps);
    }

    /// @notice Rebalance vault holdings toward target weights using token0 as a base asset.
    /// @dev This is a *mock* execution model:
    ///      - compute total units = sum(token balances)
    ///      - target units per token = total * weight
    ///      - sell excess tokens into base (token0)
    ///      - buy deficits from base into those tokens
    ///
    /// IMPORTANT: This assumes 1:1 value per token unit or MockDex rates encode value.
    function rebalance() external onlyOwner {
	if (cooldownSeconds != 0) {
	    require(block.timestamp >= lastRebalanceTs + cooldownSeconds, "COOLDOWN");
	}
	lastRebalanceTs = block.timestamp;

	uint256 nonce = ++rebalanceNonce;
	
        uint256[4] memory beforeBals = vault.balances();
        uint256 total;
        for (uint256 i = 0; i < 4; i++) total += beforeBals[i];
        require(total > 0, "EMPTY_VAULT");

	emit RebalanceStarted(nonce, total, beforeBals);

	uint256 swapsDone = 0;

	uint256[4] memory budget;
	uint256[4] memory spent;

	for (uint256 i = 0; i < 4; i++) {
	    budget[i] = Math.mulDiv(beforeBals[i], maxTradeBps, BPS_DENOM); // floor
	}


        uint256[4] memory target;
        for (uint256 i = 0; i < 4; i++) {
            target[i] = Math.mulDiv(total, weightsBps[i], BPS_DENOM); // floor
        }

	// Min drift threshold: skip if already close enough to target
	if (minDriftBps != 0) {
	    (uint16[4] memory curW, uint16 maxD) = _computeWeightsAndMaxDrift(beforeBals, weightsBps);
	    if (maxD < minDriftBps) {
		emit RebalanceSkipped(nonce, maxD, curW, weightsBps);

		// No swaps; finished state equals starting state
		emit RebalanceFinished(nonce, total, beforeBals);
		emit Rebalanced(beforeBals, beforeBals);
		return;
	    }
	}


        // Use token0 as base
        address base = vault.tokenAddress(0);

        // 1) Sell excess into base
        for (uint256 i = 1; i < 4; i++) {
	    if (beforeBals[i] > target[i]) {
		uint256 excess = beforeBals[i] - target[i];

		uint256 remaining = (budget[i] > spent[i]) ? (budget[i] - spent[i]) : 0;
		if (remaining == 0) continue;

		uint256 amountIn = excess;
		if (amountIn > remaining) amountIn = remaining;
		if (amountIn == 0) continue;

		// skip dust
		if (minTradeAmount != 0 && amountIn < minTradeAmount) continue;

		spent[i] += amountIn;
		_swapFromVault(nonce, vault.tokenAddress(i), base, amountIn);
		_swapsGuard(++swapsDone);
	    }
	}

        // Refresh base balance after sells (real balances)
        uint256[4] memory midBals = vault.balances();

        // 2) Buy deficits using base
	for (uint256 i = 1; i < 4; i++) {
	    if (midBals[i] < target[i]) {
		uint256 need = target[i] - midBals[i];

		uint256 remainingBaseBudget = (budget[0] > spent[0]) ? (budget[0] - spent[0]) : 0;
		if (remainingBaseBudget == 0) continue;

		// can't spend more base than we have
		uint256 baseAvail = midBals[0];
		if (baseAvail == 0) continue;

		uint256 amountIn = need;
		if (amountIn > remainingBaseBudget) amountIn = remainingBaseBudget;
		if (amountIn > baseAvail) amountIn = baseAvail;
		if (amountIn == 0) continue;

		// skip dust
		if (minTradeAmount != 0 && amountIn < minTradeAmount) continue;

		spent[0] += amountIn;
		_swapFromVault(nonce, base, vault.tokenAddress(i), amountIn);
		_swapsGuard(++swapsDone);

		// refresh base balance for subsequent buys (so we don't overspend if price != 1:1 later)
		midBals = vault.balances();
	    }
	}

        uint256[4] memory afterBals = vault.balances();
	uint256 totalAfter;
	for (uint256 i = 0; i < 4; i++) totalAfter += afterBals[i];

	emit RebalanceFinished(nonce, totalAfter, afterBals);
        emit Rebalanced(beforeBals, afterBals);
    }

    function _swapFromVault(uint256 nonce, address tokenIn, address tokenOut, uint256 amountIn) internal {
	// Approve DEX pull
	vault.approveToken(tokenIn, address(dex), amountIn);

	// quote and minOut (slippage guard)
	uint256 quotedOut = dex.quote(tokenIn, tokenOut, amountIn);
	uint256 minOut = Math.mulDiv(quotedOut, (BPS_DENOM - maxSlippageBps), BPS_DENOM);

	// Execute: DEX pulls from vault and sends output back to vault
	uint256 amountOut = dex.swapExactIn(address(vault), tokenIn, tokenOut, amountIn, minOut, address(vault));

	emit SwapExecuted(nonce, tokenIn, tokenOut, amountIn, quotedOut, minOut, amountOut);
    }

    function _swapsGuard(uint256 swapsDone) internal view {
	uint8 maxS = maxSwapsPerRebalance;
	if (maxS != 0) {
	    require(swapsDone <= maxS, "MAX_SWAPS");
	}
    }

    function _computeWeightsAndMaxDrift(uint256[4] memory bals, uint16[4] memory target)
	internal
	pure
	returns (uint16[4] memory current, uint16 maxDrift)
    {
	uint256 total;
	for (uint256 i = 0; i < 4; i++) total += bals[i];
	if (total == 0) return (current, 0);

	for (uint256 i = 0; i < 4; i++) {
	    uint256 w = Math.mulDiv(bals[i], BPS_DENOM, total); // floor
	    if (w > type(uint16).max) w = type(uint16).max;
	    current[i] = uint16(w);

	    uint16 t = target[i];
	    uint16 c = current[i];
	    uint16 d = c >= t ? (c - t) : (t - c);
	    if (d > maxDrift) maxDrift = d;
	}
    }



    function setMaxTradeBps(uint16 bps) external onlyOwner {
	require(bps <= BPS_DENOM, "MAX_TRADE_BPS_TOO_HIGH");
	maxTradeBps = bps;
	emit MaxTradeBpsUpdated(bps);
    }

    function setCooldownSeconds(uint32 secs) external onlyOwner {
	cooldownSeconds = secs;
	emit CooldownSecondsUpdated(secs);
    }

    function setMaxSwapsPerRebalance(uint8 n) external onlyOwner {
	// n=0 means unlimited, otherwise enforce some reasonable upper bound if you want.
	maxSwapsPerRebalance = n;
	emit MaxSwapsPerRebalanceUpdated(n);
    }

    function setMinTradeAmount(uint256 amt) external onlyOwner {
	minTradeAmount = amt;
	emit MinTradeAmountUpdated(amt);
    }

    function setMinDriftBps(uint16 bps) external onlyOwner {
	require(bps <= BPS_DENOM, "MIN_DRIFT_TOO_HIGH");
	minDriftBps = bps;
	emit MinDriftBpsUpdated(bps);
    }


}
