// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./SeasonVault.sol";

import "./SeasonRebalancer.sol";

contract SEASON is ERC20, Ownable, ReentrancyGuard {
    using Math for uint256;

    SeasonVault public immutable vault;

    SeasonRebalancer public rebalancer;

    uint256 public constant NUM_TOKENS = 4;
    uint256 public constant BPS_DENOM = 10_000;

    // Fees in basis points
    uint16 public mintFeeBps;   // e.g. 30 = 0.30%
    uint16 public redeemFeeBps; // e.g. 30 = 0.30%

    address public feeRecipient;

    event Minted(address indexed user, uint256 sharesToUser, uint256 sharesFee, uint256[4] amountsUsed);
    event Burned(address indexed user, uint256 sharesBurned, uint256 sharesFee, uint256[4] amountsReturned);
    event FeesUpdated(uint16 mintFeeBps, uint16 redeemFeeBps);
    event FeeRecipientUpdated(address indexed feeRecipient);

    event RebalancerUpdated(address indexed rebalancer);
    event VaultOperatorUpdated(address indexed operator);

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

    // ---------------- Admin (governance/treasury) ----------------

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

    // ---------------- Core: mint with deposit ----------------

    /// @notice Mint SEASON shares by depositing underlying Seasonal Tokens.
    /// @dev User supplies max amounts; contract computes exact required amounts and mints shares.
    ///      Fee is taken in shares, rounded UP to prevent fee-avoidance via splitting.
    function mintWithDeposit(uint256[4] calldata maxAmounts)
        external
        nonReentrant
        returns (uint256 sharesToUser, uint256 sharesFee, uint256[4] memory amountsUsed)
    {
        uint256 totalShares = totalSupply();
        uint256[4] memory b = vault.balances();

        uint256 grossShares;

        if (totalShares == 0) {
            // Initialization: first depositor seeds the basket.
            uint256 sum;
            for (uint256 i = 0; i < NUM_TOKENS; i++) {
                require(maxAmounts[i] > 0, "INIT_ZERO_COMPONENT");
                amountsUsed[i] = maxAmounts[i];
                sum += maxAmounts[i];
            }
            require(sum > 0, "ZERO_INIT_SUM");
            grossShares = sum;

            _pullFromUser(amountsUsed);

        } else {
            // Pro-rata mint: limited by tightest component
            grossShares = type(uint256).max;
            for (uint256 i = 0; i < NUM_TOKENS; i++) {
                require(b[i] > 0, "VAULT_EMPTY_COMPONENT");
                uint256 possible = (maxAmounts[i] * totalShares) / b[i];
                if (possible < grossShares) grossShares = possible;
            }
            require(grossShares > 0, "ZERO_SHARES");

            // Exact required amounts (floor). No donation.
            for (uint256 i = 0; i < NUM_TOKENS; i++) {
                amountsUsed[i] = Math.mulDiv(b[i], grossShares, totalShares); // floor
                require(amountsUsed[i] > 0, "ROUNDING_TO_ZERO");
                require(amountsUsed[i] <= maxAmounts[i], "MAX_EXCEEDED");
            }

            _pullFromUser(amountsUsed);
        }

        // Fee in shares, rounded UP (ceil) to avoid fee evasion by splitting mints.
        sharesFee = _ceilDiv(grossShares * mintFeeBps, BPS_DENOM);
        require(sharesFee < grossShares, "FEE_GE_100PCT");

        sharesToUser = grossShares - sharesFee;

        _mint(msg.sender, sharesToUser);
        if (sharesFee > 0) _mint(feeRecipient, sharesFee);

        emit Minted(msg.sender, sharesToUser, sharesFee, amountsUsed);
        return (sharesToUser, sharesFee, amountsUsed);
    }

    // ---------------- Core: burn to redeem ----------------

    /// @notice Burn SEASON shares to redeem pro-rata underlying.
    /// @dev Fee is taken in shares (extra shares are charged and minted to feeRecipient),
    ///      while underlying redeemed corresponds to the *net* shares burned.
    ///
    /// User pays: sharesToBurn (from their balance)
    /// - netShares = sharesToBurn - feeShares
    /// - underlying redeemed proportional to netShares / supplyBefore
    function burnToRedeem(uint256 sharesToBurn)
        external
        nonReentrant
        returns (uint256 netShares, uint256 feeShares, uint256[4] memory amountsReturned)
    {
        require(sharesToBurn > 0, "ZERO_BURN");
        require(balanceOf(msg.sender) >= sharesToBurn, "INSUFFICIENT_SHARES");

        uint256 supplyBefore = totalSupply();
        require(supplyBefore > 0, "NO_SUPPLY");

        // Fee in shares, rounded UP (ceil) to prevent fee evasion by splitting burns.
        feeShares = _ceilDiv(sharesToBurn * redeemFeeBps, BPS_DENOM);
        require(feeShares < sharesToBurn, "FEE_GE_100PCT");

        netShares = sharesToBurn - feeShares;

        uint256[4] memory b = vault.balances();

        // amountsReturned = floor(b[i] * netShares / supplyBefore)
        for (uint256 i = 0; i < NUM_TOKENS; i++) {
            amountsReturned[i] = Math.mulDiv(b[i], netShares, supplyBefore);
        }

        // Effects: burn full sharesToBurn from user
        _burn(msg.sender, sharesToBurn);

        // Mint fee shares to recipient (so total supply decreases by netShares)
        if (feeShares > 0) _mint(feeRecipient, feeShares);

        // Interactions: withdraw underlying for netShares portion
        vault.withdrawTo(msg.sender, amountsReturned);

        emit Burned(msg.sender, sharesToBurn, feeShares, amountsReturned);
        return (netShares, feeShares, amountsReturned);
    }

    /// @notice Set the rebalancer module. This does not automatically authorize it in the vault.
    function setRebalancer(address rebalancerAddr) external onlyOwner {
	require(rebalancerAddr != address(0), "REBALANCER_ZERO");
	rebalancer = SeasonRebalancer(rebalancerAddr);
	emit RebalancerUpdated(rebalancerAddr);
    }

    /// @notice Authorize an operator in the vault (typically the rebalancer).
    /// @dev SEASON owns the vault, so SEASON can set the operator directly.
    function setVaultOperator(address operatorAddr) external onlyOwner {
	vault.setOperator(operatorAddr);
	emit VaultOperatorUpdated(operatorAddr);
    }

    /// @notice Run a rebalance via the configured rebalancer module.
    /// @dev For safety, keep this onlyOwner initially. You can later add keeper logic.
    function rebalance() external onlyOwner {
	address r = address(rebalancer);
	require(r != address(0), "REBALANCER_NOT_SET");
	rebalancer.rebalance();
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
	SeasonRebalancer(rebalancer).setOracle(o);
    }

    function setRebalanceMinUnitGainBps(uint16 bps) external onlyOwner {
	require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
	SeasonRebalancer(rebalancer).setMinUnitGainBps(bps);
    }

    function setRebalanceMinSpreadBps(uint16 bps) external onlyOwner {
	require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
	SeasonRebalancer(rebalancer).setMinSpreadBps(bps);
    }
    
    function setRebalanceMinComponentBalance(uint256 a) external onlyOwner {
	require(address(rebalancer) != address(0), "REBALANCER_NOT_SET");
	SeasonRebalancer(rebalancer).setMinComponentBalance(a);
    }
    
    // ---------------- Internal helpers ----------------

    function _pullFromUser(uint256[4] memory amountsUsed) internal {
        for (uint256 i = 0; i < NUM_TOKENS; i++) {
            IERC20 t = IERC20(vault.tokenAddress(i));
            require(t.transferFrom(msg.sender, address(vault), amountsUsed[i]), "TRANSFER_FROM_FAILED");
        }
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) return 0;
        return (a + b - 1) / b;
    }
}
