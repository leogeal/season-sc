// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../external/uniswap/ISwapRouter02.sol";
import "../external/uniswap/IUniswapV3Factory.sol";

interface IQuoterV2 {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);

    function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut);
}

/// @notice Adapter that can swap tokenIn->tokenOut on Uniswap V3.
///         If no direct pool exists, it routes tokenIn->base->tokenOut (2-hop),
///         assuming pools exist for each leg.
///         `base` is the wrapped native token (WETH on Ethereum, WPOL on Polygon, etc.).
contract UniswapV3DexAdapter is Ownable {
    using SafeERC20 for IERC20;

    ISwapRouter02 public immutable router;
    IUniswapV3Factory public immutable factory;
    address public immutable base; // wrapped native (WETH, WPOL, etc.)

    IQuoterV2 public immutable quoter;

    // fee tier used for token<->base pools (token => fee)
    mapping(address => uint24) public feeToBase;

    event FeeToBaseSet(address indexed token, uint24 fee);

    error NoRoute();
    error ZeroAmount();

    constructor(address _router, address _factory, address _base, address _quoter, address initialOwner) Ownable(initialOwner) {
        router = ISwapRouter02(_router);
        factory = IUniswapV3Factory(_factory);
        base = _base;
	quoter = IQuoterV2(_quoter);
    }

    function setFeeToBase(address token, uint24 fee) external onlyOwner {
        feeToBase[token] = fee;
        emit FeeToBaseSet(token, fee);
    }

    /// @dev Pulls tokenIn from `payer` into this adapter, then swaps, sending tokenOut to `recipient`.
    function swapExactIn(
        address payer,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();

        IERC20(tokenIn).safeTransferFrom(payer, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);

        // Try direct pool first if feeToBase is not set for both, you can still set a direct fee separately,
        // but for simplicity we attempt:
        // - direct pool using feeToBase[tokenIn] if tokenOut == base, or feeToBase[tokenOut] if tokenIn == base
        // - otherwise 2-hop via base using feeToBase[tokenIn] and feeToBase[tokenOut]
        if (tokenIn == base) {
            uint24 fee = feeToBase[tokenOut];
            if (fee == 0) revert NoRoute();
            if (factory.getPool(base, tokenOut, fee) == address(0)) revert NoRoute();

            ISwapRouter02.ExactInputSingleParams memory p = ISwapRouter02.ExactInputSingleParams({
                tokenIn: base,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            });

            amountOut = router.exactInputSingle(p);
            return amountOut;
        }

        if (tokenOut == base) {
            uint24 fee = feeToBase[tokenIn];
            if (fee == 0) revert NoRoute();
            if (factory.getPool(tokenIn, base, fee) == address(0)) revert NoRoute();

            ISwapRouter02.ExactInputSingleParams memory p = ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: base,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut,
                sqrtPriceLimitX96: 0
            });

            amountOut = router.exactInputSingle(p);
            return amountOut;
        }

        // 2-hop via base
        uint24 feeIn = feeToBase[tokenIn];
        uint24 feeOut = feeToBase[tokenOut];
        if (feeIn == 0 || feeOut == 0) revert NoRoute();
        if (factory.getPool(tokenIn, base, feeIn) == address(0)) revert NoRoute();
        if (factory.getPool(base, tokenOut, feeOut) == address(0)) revert NoRoute();

        bytes memory path = abi.encodePacked(
            tokenIn, feeIn,
            base,    feeOut,
            tokenOut
        );

        ISwapRouter02.ExactInputParams memory p2 = ISwapRouter02.ExactInputParams({
            path: path,
            recipient: recipient,
            amountIn: amountIn,
            amountOutMinimum: minAmountOut
        });

        amountOut = router.exactInput(p2);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256 amountOut) {
	if (amountIn == 0) revert ZeroAmount();

	if (tokenIn == base) {
	    uint24 fee = feeToBase[tokenOut];
	    if (fee == 0) revert NoRoute();
	    if (factory.getPool(base, tokenOut, fee) == address(0)) revert NoRoute();
	    return quoter.quoteExactInputSingle(base, tokenOut, fee, amountIn, 0);
	}

	if (tokenOut == base) {
	    uint24 fee = feeToBase[tokenIn];
	    if (fee == 0) revert NoRoute();
	    if (factory.getPool(tokenIn, base, fee) == address(0)) revert NoRoute();
	    return quoter.quoteExactInputSingle(tokenIn, base, fee, amountIn, 0);
	}

	uint24 feeIn = feeToBase[tokenIn];
	uint24 feeOut = feeToBase[tokenOut];
	if (feeIn == 0 || feeOut == 0) revert NoRoute();
	if (factory.getPool(tokenIn, base, feeIn) == address(0)) revert NoRoute();
	if (factory.getPool(base, tokenOut, feeOut) == address(0)) revert NoRoute();

	bytes memory path = abi.encodePacked(tokenIn, feeIn, base, feeOut, tokenOut);
	return quoter.quoteExactInput(path, amountIn);
    }

}
