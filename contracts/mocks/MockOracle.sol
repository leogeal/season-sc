// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockOracle {
    mapping(address => uint256) public priceE18; // arbitrary common unit, scaled 1e18

    function setPriceE18(address token, uint256 p) external {
        priceE18[token] = p;
    }

    function getPriceE18(address token) external view returns (uint256) {
        return priceE18[token];
    }
}
