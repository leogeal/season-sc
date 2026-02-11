// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SeasonVault is Ownable {
    // SPRING, SUMMER, AUTUMN, WINTER, WETH
    IERC20[5] public tokens;

    address public operator;

    error NotAuthorized();
    event OperatorUpdated(address indexed operator);

    constructor(address[5] memory _tokens, address initialOwner) Ownable(initialOwner) {
        for (uint256 i = 0; i < 5; i++) {
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

    function balances() external view returns (uint256[5] memory b) {
        for (uint256 i = 0; i < 5; i++) {
            b[i] = tokens[i].balanceOf(address(this));
        }
    }

    function tokenAddress(uint256 i) external view returns (address) {
        return address(tokens[i]);
    }

    function withdrawTo(address to, uint256[5] calldata amounts) external onlyOwner {
        for (uint256 i = 0; i < 5; i++) {
            if (amounts[i] > 0) {
                require(tokens[i].transfer(to, amounts[i]), "VAULT_TRANSFER_FAILED");
            }
        }
    }

    function transferToken(address token, address to, uint256 amount) external onlyAuthorized {
        require(IERC20(token).transfer(to, amount), "VAULT_TOKEN_TRANSFER_FAILED");
    }

    function approveToken(address token, address spender, uint256 amount) external onlyAuthorized {
        IERC20 t = IERC20(token);
        require(t.approve(spender, 0), "APPROVE_RESET_FAILED");
        require(t.approve(spender, amount), "APPROVE_FAILED");
    }
}
