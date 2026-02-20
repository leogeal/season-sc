// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal wrapped native mock (WETH9/WPOL interface) for testing.
contract MockWrappedNative is ERC20 {
    constructor() ERC20("Wrapped Native", "WN") {}

    /// @notice Wrap native currency into ERC20 (like WETH9.deposit).
    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    /// @notice Unwrap ERC20 back to native currency (like WETH9.withdraw).
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "WN_WITHDRAW_FAIL");
    }

    /// @notice Allow direct ETH/POL sends to wrap automatically.
    receive() external payable {
        _mint(msg.sender, msg.value);
    }

    /// @notice Mint arbitrary amount (test helper, not in real WETH9).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
