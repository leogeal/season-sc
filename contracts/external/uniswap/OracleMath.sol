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

        uint32 [] memory secondsAgos;
        secondsAgos[0] = secondsAgo;
        secondsAgos[1] = 0;

        (int56[] memory tickCumulatives, ) = IUniswapV3Pool(pool).observe(secondsAgos);

        int56 tickDelta = tickCumulatives[1] - tickCumulatives[0];
        int56 timeDelta = int56(uint56(secondsAgo));

        // arithmeticMeanTick = tickDelta / timeDelta, rounded toward -infinity
        int56 mean = tickDelta / timeDelta;
        if (tickDelta < 0 && (tickDelta % timeDelta != 0)) mean -= 1;

        require(mean >= type(int24).min && mean <= type(int24).max, "tick OOB");
        arithmeticMeanTick = int24(mean);
    }

    /// @notice Returns quoteAmount of quoteToken for baseAmount of baseToken at `tick`.
    /// @dev Logic matches Uniswap OracleLibrary.getQuoteAtTick.
    function getQuoteAtTick(
        int24 tick,
        uint128 baseAmount,
        address baseToken,
        address quoteToken
    ) internal pure returns (uint256 quoteAmount) {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        // ratioX192 = sqrtRatioX96^2
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * uint256(sqrtRatioX96);
            if (baseToken < quoteToken) {
                quoteAmount = FullMath.mulDiv(ratioX192, baseAmount, 1 << 192);
            } else {
                quoteAmount = FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
            }
        } else {
            // Use Q128.128 to avoid overflow
            uint256 ratioX128 = FullMath.mulDiv(uint256(sqrtRatioX96), uint256(sqrtRatioX96), 1 << 64);
            if (baseToken < quoteToken) {
                quoteAmount = FullMath.mulDiv(ratioX128, baseAmount, 1 << 128);
            } else {
                quoteAmount = FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
            }
        }
    }
}
