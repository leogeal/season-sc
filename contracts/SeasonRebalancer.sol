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


    constructor(address vaultAddr, address dexAddr, address initialOwner)
        Ownable(initialOwner)
    {
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
	uint256 nonce = ++rebalanceNonce;
	
        uint256[4] memory beforeBals = vault.balances();
        uint256 total;
        for (uint256 i = 0; i < 4; i++) total += beforeBals[i];
        require(total > 0, "EMPTY_VAULT");

	emit RebalanceStarted(nonce, total, beforeBals);

        uint256[4] memory target;
        for (uint256 i = 0; i < 4; i++) {
            target[i] = Math.mulDiv(total, weightsBps[i], BPS_DENOM); // floor
        }

        // Use token0 as base
        address base = vault.tokenAddress(0);

        // 1) Sell excess into base
        for (uint256 i = 1; i < 4; i++) {
            if (beforeBals[i] > target[i]) {
                uint256 excess = beforeBals[i] - target[i];
                _swapFromVault(nonce, vault.tokenAddress(i), base, excess);
                beforeBals[i] -= excess;
                beforeBals[0] += excess; // approximate book update; actual will follow balances check
            }
        }

        // Refresh base balance after sells (real balances)
        uint256[4] memory midBals = vault.balances();

        // 2) Buy deficits using base
        for (uint256 i = 1; i < 4; i++) {
            if (midBals[i] < target[i]) {
                uint256 need = target[i] - midBals[i];
                // spend base to buy 'need' of token i, assuming rate and liquidity allow.
                _swapFromVault(nonce, base, vault.tokenAddress(i), need);
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
}
