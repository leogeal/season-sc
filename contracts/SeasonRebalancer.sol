// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./SeasonVault.sol";

interface IPriceOracle {
    function getPriceE18(address token) external view returns (uint256);
}

interface IDexAdapter {
    function swapExactIn(
        address payer,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut);
}

/// @notice Contrarian: swap from most expensive token -> cheapest token,
///         but only if oracle-implied raw unit gain exists and router enforces amountOutMinimum.
/// @dev Decisioning uses TWAP oracle; execution uses DEX adapter with minOut protection.
///      Caller may supply an additional minOut bound (e.g. from QuoterV2) which tightens execution.
contract SeasonRebalancer is Ownable {
    using Math for uint256;

    uint256 public constant BPS_DENOM = 10_000;

    SeasonVault public immutable vault;
    IDexAdapter public immutable dex;

    IPriceOracle public oracle;

    // Guardrails
    uint32 public cooldownSeconds;
    uint40 public lastRebalanceAt;

    uint16 public maxTradeBps = 1_000;      // 10% of expensive token balance
    uint8  public maxSwapsPerRebalance = 1; // strategy uses one swap
    uint256 public minTradeAmount;

    // Require oracle price spread between expensive and cheap to be at least this (bps)
    uint16 public minSpreadBps;
    uint256 public minComponentBalance; // keep at least this much of each token in vault

    // Execution controls
    uint16 public maxSlippageBps = 50;  // oracle-based minOut haircut (0.50%)
    uint16 public minUnitGainBps = 1;   // require oracle expectedOut >= ceil(in*(1+0.01%))

    uint64 public rebalanceNonce;

    event RebalanceStarted(uint64 indexed nonce);
    event RebalanceSkipped(uint64 indexed nonce, string reason);
    event SwapExecuted(uint64 indexed nonce, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    event RebalanceFinished(uint64 indexed nonce);

    error OracleNotSet();
    error InvalidOraclePrice();
    error CooldownActive();
    error MaxSwapsTooLow();

    constructor(address vault_, address dex_, address initialOwner) Ownable(initialOwner) {
        vault = SeasonVault(vault_);
        dex = IDexAdapter(dex_);
    }

    // ---- setters (owner = SEASON) ----
    function setOracle(address o) external onlyOwner { oracle = IPriceOracle(o); }
    function setCooldownSeconds(uint32 s) external onlyOwner { cooldownSeconds = s; }
    function setMaxTradeBps(uint16 bps) external onlyOwner { require(bps <= BPS_DENOM, "MAX_TRADE_BPS"); maxTradeBps = bps; }
    function setMaxSwapsPerRebalance(uint8 n) external onlyOwner { maxSwapsPerRebalance = n; }
    function setMinTradeAmount(uint256 a) external onlyOwner { minTradeAmount = a; }
    function setMinSpreadBps(uint16 bps) external onlyOwner { require(bps <= BPS_DENOM, "MIN_SPREAD"); minSpreadBps = bps; }
    function setMaxSlippageBps(uint16 bps) external onlyOwner { require(bps <= BPS_DENOM, "MAX_SLIPPAGE"); maxSlippageBps = bps; }
    function setMinUnitGainBps(uint16 bps) external onlyOwner { require(bps <= BPS_DENOM, "MIN_GAIN"); minUnitGainBps = bps; }

    function setMinComponentBalance(uint256 a) external onlyOwner {
        minComponentBalance = a;
    }

    /// @notice Execute rebalance. If minOutFromCaller > 0, it tightens the oracle-derived minOut.
    /// @dev Use minOutFromCaller from QuoterV2 off-chain if you want tighter bounds.
    function rebalance(uint256 minOutFromCaller) external onlyOwner {
        if (address(oracle) == address(0)) revert OracleNotSet();

        uint256 nowTs = block.timestamp;
        if (cooldownSeconds != 0 && nowTs < uint256(lastRebalanceAt) + cooldownSeconds) revert CooldownActive();

        if (maxSwapsPerRebalance < 1) revert MaxSwapsTooLow();

        rebalanceNonce += 1;
        uint64 n = rebalanceNonce;
        emit RebalanceStarted(n);

	uint256[5] memory b = vault.balances();  // 4 seasonals + WETH
	address[4] memory t;
	uint256[4] memory p;

        for (uint256 i = 0; i < 4; i++) {
            t[i] = vault.tokenAddress(i);
            p[i] = oracle.getPriceE18(t[i]);
            if (p[i] == 0) revert InvalidOraclePrice();
        }

        (uint256 iExp, uint256 iCheap) = _argMaxMin(p);
        if (iExp == iCheap) {
            emit RebalanceSkipped(n, "NO_SPREAD");
            lastRebalanceAt = uint40(nowTs);
            emit RebalanceFinished(n);
            return;
        }

        // Spread check: (pExp/pCheap - 1) in bps
        uint256 ratioBps = (p[iExp] * BPS_DENOM) / p[iCheap]; // >= 10000
        uint256 spreadBps = ratioBps > BPS_DENOM ? (ratioBps - BPS_DENOM) : 0;
        if (spreadBps < minSpreadBps) {
            emit RebalanceSkipped(n, "SPREAD_TOO_SMALL");
            lastRebalanceAt = uint40(nowTs);
            emit RebalanceFinished(n);
            return;
        }

        // trade size: capped fraction of expensive balance, but keep minComponentBalance
        uint256 balExp = b[iExp];
        if (balExp <= minComponentBalance) {
            emit RebalanceSkipped(n, "EXPENSIVE_AT_FLOOR");
            lastRebalanceAt = uint40(nowTs);
            emit RebalanceFinished(n);
            return;
        }

        uint256 amountIn = (balExp * maxTradeBps) / BPS_DENOM;

        uint256 maxSell = balExp - minComponentBalance;
        if (amountIn > maxSell) amountIn = maxSell;

        if (amountIn == 0 || (minTradeAmount != 0 && amountIn < minTradeAmount)) {
            emit RebalanceSkipped(n, "TRADE_TOO_SMALL");
            lastRebalanceAt = uint40(nowTs);
            emit RebalanceFinished(n);
            return;
        }

        address tokenIn = t[iExp];
        address tokenOut = t[iCheap];

        // Oracle-implied expectedOut in tokenOut smallest units
        uint256 expectedOut = _expectedOutFromOracle(tokenIn, tokenOut, amountIn, p[iExp], p[iCheap]);

        // Require unit gain: expectedOut >= ceil(in*(1+minUnitGainBps))
        uint256 minOutGain = Math.mulDiv(
            amountIn,
            (BPS_DENOM + minUnitGainBps),
            BPS_DENOM,
            Math.Rounding.Ceil
        );

        if (expectedOut < minOutGain) {
            emit RebalanceSkipped(n, "NO_UNIT_GAIN");
            lastRebalanceAt = uint40(nowTs);
            emit RebalanceFinished(n);
            return;
        }

        // Slippage floor from oracle expectation
        uint256 minOutSlip = Math.mulDiv(expectedOut, (BPS_DENOM - maxSlippageBps), BPS_DENOM);

        uint256 minOut = minOutSlip > minOutGain ? minOutSlip : minOutGain;

        // Optional tighter bound from caller (keeper using QuoterV2)
        if (minOutFromCaller > minOut) minOut = minOutFromCaller;

        // Approve adapter to pull tokenIn FROM vault, then swap back to vault
        vault.approveToken(tokenIn, address(dex), amountIn);
        uint256 amountOut = dex.swapExactIn(address(vault), tokenIn, tokenOut, amountIn, minOut, address(vault));

        emit SwapExecuted(n, tokenIn, tokenOut, amountIn, amountOut);

        lastRebalanceAt = uint40(nowTs);
        emit RebalanceFinished(n);
    }

    // expectedOut = amountIn * pIn / 10^decIn * 10^decOut / pOut
    // pIn and pOut are "base per 1 token" scaled 1e18, so base cancels in ratio.
    function _expectedOutFromOracle(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 pInE18,
        uint256 pOutE18
    ) internal view returns (uint256 expectedOut) {
        uint8 decIn = IERC20Metadata(tokenIn).decimals();
        uint8 decOut = IERC20Metadata(tokenOut).decimals();

        uint256 denomIn = 10 ** uint256(decIn);
        uint256 scaleOut = 10 ** uint256(decOut);

        // valueBaseE18 = amountIn * pIn / 10^decIn  (use mulDiv to avoid overflow)
        uint256 valueBaseE18 = Math.mulDiv(amountIn, pInE18, denomIn);

        // expectedOut = valueBaseE18 * 10^decOut / pOut
        expectedOut = Math.mulDiv(valueBaseE18, scaleOut, pOutE18);
    }

    function _argMaxMin(uint256[4] memory p) internal pure returns (uint256 iMax, uint256 iMin) {
        iMax = 0; iMin = 0;
        for (uint256 i = 1; i < 4; i++) {
            if (p[i] > p[iMax]) iMax = i;
            if (p[i] < p[iMin]) iMin = i;
        }
    }
}
