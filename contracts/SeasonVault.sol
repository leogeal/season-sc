// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SeasonVault is Ownable {
    IERC20[4] public tokens; // SPRING, SUMMER, AUTUMN, WINTER

    constructor(address[4] memory _tokens, address initialOwner) Ownable(initialOwner) {
        for (uint256 i = 0; i < 4; i++) {
            tokens[i] = IERC20(_tokens[i]);
        }
    }

    function balances() external view returns (uint256[4] memory b) {
        for (uint256 i = 0; i < 4; i++) {
            b[i] = tokens[i].balanceOf(address(this));
        }
    }

    function tokenAddress(uint256 i) external view returns (address) {
        return address(tokens[i]);
    }

    /// @notice Withdraw specific amounts of each component to `to`.
    /// @dev Only the owner (SEASON contract after transferOwnership) can call this.
    function withdrawTo(address to, uint256[4] calldata amounts) external onlyOwner {
        for (uint256 i = 0; i < 4; i++) {
            if (amounts[i] > 0) {
                require(tokens[i].transfer(to, amounts[i]), "VAULT_TRANSFER_FAILED");
            }
        }
    }
}
