// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract MockDex is Ownable {
    using Math for uint256;

    uint256 public constant BPS_DENOM = 10_000;

    // rate[tokenIn][tokenOut] = amountOut per 1e18 amountIn, as 1e18-fixed-point
    mapping(address => mapping(address => uint256)) public rateE18;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rateE18);
    event Swapped(address indexed payer, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setRateE18(address tokenIn, address tokenOut, uint256 _rateE18) external onlyOwner {
        rateE18[tokenIn][tokenOut] = _rateE18;
        emit RateSet(tokenIn, tokenOut, _rateE18);
    }

    /// @notice Quote amountOut for a swap (no fees, deterministic).
    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 r = rateE18[tokenIn][tokenOut];
        require(r > 0, "NO_RATE");
        // amountOut = amountIn * r / 1e18
        return Math.mulDiv(amountIn, r, 1e18);
    }

    /// @notice Swap exact input for output at the configured rate.
    /// @dev DEX pulls tokenIn from `payer` (must approve this contract), and sends tokenOut to `recipient`.
    function swapExactIn(
	address payer,
	address tokenIn,
	address tokenOut,
	uint256 amountIn,
	uint256 minAmountOut,
	address recipient
    ) external returns (uint256 amountOut) {
	amountOut = quote(tokenIn, tokenOut, amountIn);
	require(amountOut >= minAmountOut, "SLIPPAGE");

	require(IERC20(tokenIn).transferFrom(payer, address(this), amountIn), "IN_TRANSFER_FAILED");
	require(IERC20(tokenOut).transfer(recipient, amountOut), "OUT_TRANSFER_FAILED");

	emit Swapped(payer, tokenIn, tokenOut, amountIn, amountOut);
    }
}
