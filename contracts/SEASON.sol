// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./SeasonVault.sol";
import "./SeasonRebalancer.sol";
import "./interfaces/IPriceOracle.sol";

interface IWrappedNative {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract SEASON is ERC20, Ownable, ReentrancyGuard {
    using Math for uint256;

    SeasonVault public immutable vault;
    SeasonRebalancer public rebalancer;

    // 4 seasonals + wrapped native (WETH on Ethereum, WPOL on Polygon, etc.)
    uint256 public constant NUM_SEASONALS = 4;
    uint256 public constant NUM_ASSETS = 5;
    uint256 public constant WRAPPED_NATIVE_INDEX = 4;

    uint256 public constant BPS_DENOM = 10_000;

    // Fees in basis points
    uint16 public mintFeeBps;
    uint16 public redeemFeeBps;

    address public feeRecipient;

    // Wrapped native token + oracle (oracle returns wrapped native per 1 token, scaled 1e18)
    address public wrappedNative;
    IPriceOracle public oracle;

    // Events
    event Minted(address indexed user, uint256 sharesToUser, uint256 sharesFee, uint256[4] amountsUsed);
    event Burned(address indexed user, uint256 sharesBurned, uint256 sharesFee, uint256[5] amountsReturned);
    event FeesUpdated(uint16 mintFeeBps, uint16 redeemFeeBps);
    event FeeRecipientUpdated(address indexed feeRecipient);

    event RebalancerUpdated(address indexed rebalancer);
    event VaultOperatorUpdated(address indexed operator);

    event WrappedNativeUpdated(address indexed wrappedNative);
    event OracleUpdated(address indexed oracle);
    event MintedWithWrappedNative(address indexed user, uint256 amount, uint256 sharesToUser, uint256 sharesFee);

    constructor(address vaultAddr, address initialOwner, address _feeRecipient)
        ERC20("Season Index Token", "SEASON")
        Ownable(initialOwner)
    {
        require(_feeRecipient != address(0), "FEE_RECIPIENT_ZERO");
        vault = SeasonVault(vaultAddr);
        feeRecipient = _feeRecipient;
        mintFeeBps = 0;
        redeemFeeBps = 0;
    }

    // ---------------- Admin ----------------

    function setFees(uint16 _mintFeeBps, uint16 _redeemFeeBps) external onlyOwner {
        require(_mintFeeBps <= 1_000, "MINT_FEE_TOO_HIGH");     // <= 10%
        require(_redeemFeeBps <= 1_000, "REDEEM_FEE_TOO_HIGH"); // <= 10%
        mintFeeBps = _mintFeeBps;
        redeemFeeBps = _redeemFeeBps;
        emit FeesUpdated(_mintFeeBps, _redeemFeeBps);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "FEE_RECIPIENT_ZERO");
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    function setWrappedNative(address _wrappedNative) external onlyOwner {
        require(_wrappedNative != address(0), "WRAPPED_NATIVE_ZERO");
        wrappedNative = _wrappedNative;
        emit WrappedNativeUpdated(_wrappedNative);
    }

    function setOracle(address o) external onlyOwner {
        require(o != address(0), "ORACLE_ZERO");
        oracle = IPriceOracle(o);
        emit OracleUpdated(o);
    }

    // ---------------- NAV helpers ----------------

    function _amountValueInBase(address token, uint256 amount) internal view returns (uint256) {
        if (token == wrappedNative) return amount; // wrapped native is the base
        uint256 p = oracle.getPriceE18(token); // base per 1 token, scaled 1e18
        uint8 dec = IERC20Metadata(token).decimals();
        return Math.mulDiv(amount, p, 10 ** uint256(dec));
    }

    function _vaultNavInBase() internal view returns (uint256 nav) {
        uint256[5] memory b = vault.balances();
        for (uint256 i = 0; i < NUM_ASSETS; i++) {
            address t = vault.tokenAddress(i);
            nav += _amountValueInBase(t, b[i]);
        }
    }

    // ---------------- Core: mint with pro-rata seasonal deposit ----------------

    /// @notice Mint SEASON by depositing the 4 seasonal tokens pro-rata.
    /// @dev This is your original pro-rata mint path (ignores wrapped native buffer).
    function mintWithDeposit(uint256[4] calldata maxAmounts)
        external
        nonReentrant
        returns (uint256 sharesToUser, uint256 sharesFee, uint256[4] memory amountsUsed)
    {
        uint256 totalShares = totalSupply();
        uint256[5] memory b5 = vault.balances();

        uint256 grossShares;

        if (totalShares == 0) {
            // Initialization: first depositor seeds the basket (seasonals only).
            uint256 sum;
            for (uint256 i = 0; i < NUM_SEASONALS; i++) {
                require(maxAmounts[i] > 0, "INIT_ZERO_COMPONENT");
                amountsUsed[i] = maxAmounts[i];
                sum += maxAmounts[i];
            }
            require(sum > 0, "ZERO_INIT_SUM");
            grossShares = sum;

            _pullSeasonalsFromUser(amountsUsed);

        } else {
            // Pro-rata mint: limited by tightest seasonal component
            grossShares = type(uint256).max;
            for (uint256 i = 0; i < NUM_SEASONALS; i++) {
                require(b5[i] > 0, "VAULT_EMPTY_COMPONENT");
                uint256 possible = (maxAmounts[i] * totalShares) / b5[i];
                if (possible < grossShares) grossShares = possible;
            }
            require(grossShares > 0, "ZERO_SHARES");

            for (uint256 i = 0; i < NUM_SEASONALS; i++) {
                amountsUsed[i] = Math.mulDiv(b5[i], grossShares, totalShares); // floor
                require(amountsUsed[i] > 0, "ROUNDING_TO_ZERO");
                require(amountsUsed[i] <= maxAmounts[i], "MAX_EXCEEDED");
            }

            _pullSeasonalsFromUser(amountsUsed);
        }

        sharesFee = _ceilDiv(grossShares * mintFeeBps, BPS_DENOM);
        require(sharesFee < grossShares, "FEE_GE_100PCT");

        sharesToUser = grossShares - sharesFee;

        _mint(msg.sender, sharesToUser);
        if (sharesFee > 0) _mint(feeRecipient, sharesFee);

        emit Minted(msg.sender, sharesToUser, sharesFee, amountsUsed);
        return (sharesToUser, sharesFee, amountsUsed);
    }

    // ---------------- Core: mint with native / wrapped native ----------------

    /// @notice Deposit native currency (ETH/POL) -> wrapped native into the vault, mint shares (NAV-based).
    /// @dev Requires oracle + wrappedNative set. First mint must use mintWithDeposit.
    function mintWithNative() external payable nonReentrant returns (uint256 sharesToUser, uint256 sharesFee) {
        require(msg.value > 0, "NO_VALUE");
        require(wrappedNative != address(0), "WRAPPED_NATIVE_NOT_SET");
        require(address(oracle) != address(0), "ORACLE_NOT_SET");
        require(totalSupply() > 0, "INIT_USE_MINTWITHDEPOSIT");

        uint256 supplyBefore = totalSupply();
        uint256 navBefore = _vaultNavInBase();
        require(navBefore > 0, "BAD_NAV");

        IWrappedNative(wrappedNative).deposit{value: msg.value}();
        require(IWrappedNative(wrappedNative).transfer(address(vault), msg.value), "WRAPPED_NATIVE_XFER_FAIL");

        uint256 grossShares = Math.mulDiv(msg.value, supplyBefore, navBefore);

        sharesFee = _ceilDiv(grossShares * mintFeeBps, BPS_DENOM);
        require(sharesFee < grossShares, "FEE_GE_100PCT");

        sharesToUser = grossShares - sharesFee;
        _mint(msg.sender, sharesToUser);
        if (sharesFee > 0) _mint(feeRecipient, sharesFee);

        emit MintedWithWrappedNative(msg.sender, msg.value, sharesToUser, sharesFee);
    }

    /// @notice Deposit wrapped native token (WETH/WPOL) into the vault, mint shares (NAV-based).
    function mintWithWrappedNative(uint256 amount) external nonReentrant returns (uint256 sharesToUser, uint256 sharesFee) {
        require(amount > 0, "NO_WRAPPED_NATIVE");
        require(wrappedNative != address(0), "WRAPPED_NATIVE_NOT_SET");
        require(address(oracle) != address(0), "ORACLE_NOT_SET");
        require(totalSupply() > 0, "INIT_USE_MINTWITHDEPOSIT");

        uint256 supplyBefore = totalSupply();
        uint256 navBefore = _vaultNavInBase();
        require(navBefore > 0, "BAD_NAV");

        require(IWrappedNative(wrappedNative).transferFrom(msg.sender, address(vault), amount), "WRAPPED_NATIVE_TF_FAIL");

        uint256 grossShares = Math.mulDiv(amount, supplyBefore, navBefore);

        sharesFee = _ceilDiv(grossShares * mintFeeBps, BPS_DENOM);
        require(sharesFee < grossShares, "FEE_GE_100PCT");

        sharesToUser = grossShares - sharesFee;
        _mint(msg.sender, sharesToUser);
        if (sharesFee > 0) _mint(feeRecipient, sharesFee);

        emit MintedWithWrappedNative(msg.sender, amount, sharesToUser, sharesFee);
    }

    // ---------------- Core: burn to redeem (5 assets) ----------------

    function burnToRedeem(uint256 sharesToBurn)
        external
        nonReentrant
        returns (uint256 netShares, uint256 feeShares, uint256[5] memory amountsReturned)
    {
        require(sharesToBurn > 0, "ZERO_BURN");
        require(balanceOf(msg.sender) >= sharesToBurn, "INSUFFICIENT_SHARES");

        uint256 supplyBefore = totalSupply();
        require(supplyBefore > 0, "NO_SUPPLY");

        feeShares = _ceilDiv(sharesToBurn * redeemFeeBps, BPS_DENOM);
        require(feeShares < sharesToBurn, "FEE_GE_100PCT");

        netShares = sharesToBurn - feeShares;

        uint256[5] memory b = vault.balances();

        for (uint256 i = 0; i < NUM_ASSETS; i++) {
            amountsReturned[i] = Math.mulDiv(b[i], netShares, supplyBefore);
        }

        _burn(msg.sender, sharesToBurn);

        if (feeShares > 0) _mint(feeRecipient, feeShares);

        vault.withdrawTo(msg.sender, amountsReturned);

        emit Burned(msg.sender, sharesToBurn, feeShares, amountsReturned);
        return (netShares, feeShares, amountsReturned);
    }

    // ---------------- Rebalancer wiring ----------------

    function setRebalancer(address rebalancerAddr) external onlyOwner {
        require(rebalancerAddr != address(0), "REBALANCER_ZERO");
        rebalancer = SeasonRebalancer(rebalancerAddr);
        emit RebalancerUpdated(rebalancerAddr);
    }

    function setVaultOperator(address operatorAddr) external onlyOwner {
        vault.setOperator(operatorAddr);
        emit VaultOperatorUpdated(operatorAddr);
    }

    function rebalance() external onlyOwner {
        address r = address(rebalancer);
        require(r != address(0), "REBALANCER_NOT_SET");
        rebalancer.rebalance(0);
    }

    function rebalanceWithMinOut(uint256 minAmountOut) external onlyOwner {
        address r = address(rebalancer);
        require(r != address(0), "REBALANCER_NOT_SET");
        rebalancer.rebalance(minAmountOut);
    }

    function setRebalanceWeights(uint16[4] calldata /*w*/) external view onlyOwner {
        revert("WEIGHTS_DISABLED");
    }

    function setRebalanceMaxTradeBps(uint16 bps) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMaxTradeBps(bps);
    }

    function setRebalanceCooldownSeconds(uint32 secs) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setCooldownSeconds(secs);
    }

    function setRebalanceMaxSwapsPerRebalance(uint8 n) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMaxSwapsPerRebalance(n);
    }

    function setRebalanceMinTradeAmount(uint256 amt) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMinTradeAmount(amt);
    }

    function setRebalanceMinDriftBps(uint16 bps) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMinSpreadBps(bps);
    }

    function setRebalanceOracle(address o) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setOracle(o);
    }

    function setRebalanceMinUnitGainBps(uint16 bps) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMinUnitGainBps(bps);
    }

    function setRebalanceMinSpreadBps(uint16 bps) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMinSpreadBps(bps);
    }

    function setRebalanceMinComponentBalance(uint256 a) external onlyOwner {
        require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
        rebalancer.setMinComponentBalance(a);
    }

    // ---------------- Internal helpers ----------------

    function _pullSeasonalsFromUser(uint256[4] memory amountsUsed) internal {
        for (uint256 i = 0; i < NUM_SEASONALS; i++) {
            IERC20 t = IERC20(vault.tokenAddress(i));
            require(t.transferFrom(msg.sender, address(vault), amountsUsed[i]), "TRANSFER_FROM_FAILED");
        }
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) return 0;
        return (a + b - 1) / b;
    }

    receive() external payable {
        revert("USE_MINTWITHNATIVE");
    }
}
