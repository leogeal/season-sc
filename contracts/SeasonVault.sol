// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SeasonVault is Ownable {
    IERC20[4] public tokens; // SPRING, SUMMER, AUTUMN, WINTER

    // Optional operator that can move funds for rebalancing (e.g., a strategy module)
    address public operator;

    error NotAuthorized();

    event OperatorUpdated(address indexed operator);

    constructor(address[4] memory _tokens, address initialOwner) Ownable(initialOwner) {
        for (uint256 i = 0; i < 4; i++) {
            tokens[i] = IERC20(_tokens[i]);
        }
    }

    modifier onlyAuthorized() {
        if (msg.sender != owner() && msg.sender != operator) revert NotAuthorized();
        _;
    }

    function setOperator(address _operator) external onlyOwner {
        operator = _operator;
        emit OperatorUpdated(_operator);
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
    /// @dev Only the owner (SEASON) can call this. Keeps redemption centralized in SEASON.
    function withdrawTo(address to, uint256[4] calldata amounts) external onlyOwner {
        for (uint256 i = 0; i < 4; i++) {
            if (amounts[i] > 0) {
                require(tokens[i].transfer(to, amounts[i]), "VAULT_TRANSFER_FAILED");
            }
        }
    }

    /// @notice Transfer a single token out (used by rebalancer).
    function transferToken(address token, address to, uint256 amount) external onlyAuthorized {
        require(IERC20(token).transfer(to, amount), "VAULT_TOKEN_TRANSFER_FAILED");
    }

    /// @notice Approve a spender for a token (used by rebalancer to allow DEX pulls).
    function approveToken(address token, address spender, uint256 amount) external onlyAuthorized {
        // Many ERC20s require setting allowance to 0 first; do the safe pattern.
        IERC20 t = IERC20(token);
        require(t.approve(spender, 0), "APPROVE_RESET_FAILED");
        require(t.approve(spender, amount), "APPROVE_FAILED");
    }
}
