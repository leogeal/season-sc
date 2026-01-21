// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract SeasonRebalancer is Ownable {
    constructor(address initialOwner) Ownable(initialOwner) {}

    function rebalance() external onlyOwner {
        // stub
    }
}
