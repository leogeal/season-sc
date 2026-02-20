// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "../external/uniswap/IUniswapV3Factory.sol";
import "../external/uniswap/OracleMath.sol";

/// @notice Minimal TWAP oracle that returns priceE18[token] in terms of a chosen base token
///         (e.g. WETH on Ethereum, WPOL on Polygon).
/// @dev Requires an existing Uniswap V3 pool (token, base, fee) with enough observations.
contract UniswapV3TwapOracle is Ownable {
    IUniswapV3Factory public immutable factory;
    address public immutable base; // e.g., WETH on Ethereum, WPOL on Polygon

    struct Config {
        uint24 fee;          // pool fee tier for (token, base)
        uint32 secondsAgo;   // TWAP window
        bool enabled;
    }

    mapping(address => Config) public config; // token => config

    event TokenConfigured(address indexed token, uint24 fee, uint32 secondsAgo, bool enabled);

    error NoPool(address token);
    error NotEnabled(address token);

    constructor(address _factory, address _base, address initialOwner) Ownable(initialOwner) {
        factory = IUniswapV3Factory(_factory);
        base = _base;
    }

    function setTokenConfig(address token, uint24 fee, uint32 secondsAgo, bool enabled) external onlyOwner {
        config[token] = Config({ fee: fee, secondsAgo: secondsAgo, enabled: enabled });
        emit TokenConfigured(token, fee, secondsAgo, enabled);
    }

    /// @notice Return token price in base, scaled to 1e18: priceE18 = (baseUnits per 1 token) * 1e18.
    function getPriceE18(address token) external view returns (uint256) {
        if (token == base) return 1e18;

        Config memory c = config[token];
        if (!c.enabled) revert NotEnabled(token);

        address pool = factory.getPool(token, base, c.fee);
        if (pool == address(0)) revert NoPool(token);

        int24 twapTick = OracleMath.consult(pool, c.secondsAgo);

        uint256 tokenOne = 10 ** IERC20Metadata(token).decimals();
        uint256 baseOut = OracleMath.getQuoteAtTick(twapTick, uint128(tokenOne), token, base);

        // Normalize baseOut to 1e18
        uint8 baseDec = IERC20Metadata(base).decimals();
        if (baseDec == 18) return baseOut;
        if (baseDec < 18) return baseOut * (10 ** (18 - baseDec));
        return baseOut / (10 ** (baseDec - 18));
    }
}
