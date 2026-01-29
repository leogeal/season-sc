// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../external/uniswap/OracleMath.sol";

contract MockUniswapV3Pool {
    int56[] private tickCumulativesToReturn;
    bool private shouldRevert; // Control flag for testing failure

    function setTickCumulatives(int56[] memory _cumulatives) external {
        tickCumulativesToReturn = _cumulatives;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        if (shouldRevert) {
            // Simulate Uniswap V3 "OLD" revert
            revert("OLD");
        }

        require(tickCumulativesToReturn.length == secondsAgos.length, "Mock: length mismatch");
        uint160[] memory unusedLiquidity = new uint160[](secondsAgos.length);
        return (tickCumulativesToReturn, unusedLiquidity);
    }
    
    // Mock for preparePool
    function increaseObservationCardinalityNext(uint16 /*observationCardinalityNext*/) external pure {
        // In a real pool, this would write to storage. 
        // For mock, we just ensure the call succeeds.
    }
}

contract OracleMathHarness {
    function consult(address pool, uint32 secondsAgo) external view returns (int24) {
        return OracleMath.consult(pool, secondsAgo);
    }

    // New harness function to test preparePool
    function preparePool(address pool, uint16 cardinality) external {
        OracleMath.preparePool(pool, cardinality);
    }
    
    // ... getQuoteAtTick remains the same ...
    function getQuoteAtTick(int24 tick, uint128 baseAmount, address baseToken, address quoteToken) external pure returns (uint256) {
        return OracleMath.getQuoteAtTick(tick, baseAmount, baseToken, quoteToken);
    }
}
