// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IUniswapV3Pool.sol";
import "./TickMath.sol";
import "./FullMath.sol";

/// @notice Minimal TWAP + quote helpers (0.8.20 compatible).
library OracleMath {
    /// @notice Returns the time-weighted average tick over `secondsAgo`.
    /// @dev Uses observe([secondsAgo, 0]).
    function consult(address pool, uint32 secondsAgo) internal view returns (int24 arithmeticMeanTick) {
        require(secondsAgo > 0, "secondsAgo=0");

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        // WRAPPER: try/catch to handle cases where the pool history is too short
        try IUniswapV3Pool(pool).observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
            int56 timeDelta = int56(uint56(secondsAgo));

            int56 mean = tickDelta / timeDelta;
            if (tickDelta < 0 && (tickDelta % timeDelta != 0)) mean -= 1;

            require(mean >= type(int24).min && mean <= type(int24).max, "tick OOB");
            arithmeticMeanTick = int24(mean);
        } catch {
            // This usually happens if 'secondsAgo' is older than the pool's oldest observation
            revert("OracleMath: Pool has insufficient history");
        }
    }

    /// @notice Expands the pool's observation cardinality if it's less than `observationCardinalityNext`.
    /// @dev This must be called via a transaction (not view) to write to state.
    function preparePool(address pool, uint16 cardinality) internal {
        IUniswapV3Pool(pool).increaseObservationCardinalityNext(cardinality);
    }

    /// @notice Returns quoteAmount of quoteToken for baseAmount of baseToken at `tick`.
    function getQuoteAtTick(
        int24 tick,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * uint256(sqrtRatioX96);
            if (baseToken < quoteToken) {
                quoteAmount = FullMath.mulDiv(ratioX192, baseAmount, 1 << 192);
            } else {
                quoteAmount = FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
            }
        } else {
            uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtRatioX96), uint256(sqrtRatioX96), 1 << 64);
            if (baseToken < quoteToken) {
                quoteAmount = FullMath.mulDiv(ratioX128, baseAmount, 1 << 128);
            } else {
                quoteAmount = FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
            }
        }
    }
}

