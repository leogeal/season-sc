# CLAUDE.md

## Project Overview

SEASON is an ERC20 investment fund smart contract that holds a portfolio of four Seasonal Tokens (SPRING, SUMMER, AUTUMN, WINTER) and performs automated contrarian rebalancing — selling the most expensive token for the cheapest based on TWAP oracle prices.

Users mint SEASON shares by depositing all four underlying tokens pro-rata, and burn shares to redeem their proportional claim on the vault.

## Tech Stack

- **Language:** Solidity 0.8.20
- **Framework:** Hardhat 2.19.5
- **Testing:** Hardhat + Ethereum-Waffle + Chai (JavaScript)
- **Libraries:** OpenZeppelin Contracts 5.4.0, Uniswap V3 Core/Periphery
- **Node:** v20 LTS

## Commands

```bash
npm ci                    # Install dependencies (use ci, not install)
npx hardhat compile       # Compile contracts
npm test                  # Run all tests
npx hardhat coverage      # Generate coverage report
REPORT_GAS=1 npx hardhat test  # Run tests with gas reporting
```

## Directory Structure

```
contracts/
  SEASON.sol              # Main ERC20 token: mint/burn entry points, admin facade
  SeasonVault.sol         # Holds the 4 underlying tokens, operator auth pattern
  SeasonRebalancer.sol    # Contrarian strategy: swap expensive -> cheap with guardrails
  dex/
    UniswapV3DexAdapter.sol   # Uniswap V3 swap execution (1-hop or 2-hop via WETH)
  oracle/
    UniswapV3TwapOracle.sol   # TWAP price oracle from Uniswap V3 pools
  external/
    uniswap/              # Vendored Uniswap V3 interfaces and math libraries
  mocks/
    MockERC20.sol         # Test mock: mintable ERC20
    MockDex.sol           # Test mock: deterministic swap rates
    MockOracle.sol        # Test mock: settable prices
test/
  season.*.test.js        # 13 test files covering all contract functionality
```

## Architecture

```
SEASON (ERC20, Ownable)
  ├── SeasonVault          # Stores SPRING/SUMMER/AUTUMN/WINTER balances
  │     └── operator auth  # Rebalancer authorized as vault operator
  └── SeasonRebalancer     # Contrarian strategy module
        ├── IPriceOracle   # UniswapV3TwapOracle (TWAP prices in base/1e18)
        └── IDexAdapter    # UniswapV3DexAdapter (swap execution)
```

**Ownership chain:** SEASON owns the vault. SEASON owns the rebalancer. The deployer/governance owns SEASON. All rebalancer parameter changes go through SEASON's admin facade (`setRebalance*` functions).

**Key design decisions:**
- Fees are taken in SEASON shares (minted to feeRecipient), not in underlying tokens
- Fee rounding uses ceiling division to prevent fee-avoidance via split deposits
- Pro-rata mint/burn uses `Math.mulDiv` (floor) for amounts; rounding dust stays in vault
- Rebalancer has multiple skip conditions (spread too small, trade too small, no unit gain, cooldown active, balance at floor) — all emit `RebalanceSkipped` events with a reason string
- The vault uses a two-role auth model: `owner` (SEASON contract) and `operator` (rebalancer)

## Code Conventions

### Solidity
- License: `SPDX-License-Identifier: MIT`
- Pragma: `^0.8.20`
- Compiler: optimizer enabled (200 runs), viaIR enabled
- Use OpenZeppelin v5 patterns: `Ownable(initialOwner)` constructor style
- Custom errors preferred for rebalancer (`error CooldownActive()`); revert strings used in SEASON/vault (`require(..., "REASON_CODE")`)
- Error strings use SCREAMING_SNAKE_CASE: `"VAULT_EMPTY_COMPONENT"`, `"FEE_GE_100PCT"`
- Constants: `uint256 public constant BPS_DENOM = 10_000`
- Basis points (bps) for all percentage parameters; denominator is always 10,000
- Fixed-size arrays `[4]` for the four seasonal tokens (no dynamic arrays)
- Events emitted for all state changes and rebalance lifecycle

### JavaScript Tests
- Use `require("chai")` and `require("hardhat")` — CommonJS, not ES modules
- Helper `bn(x)` or `P(x)` shorthand for `ethers.BigNumber.from` / `ethers.utils.parseUnits`
- Test file naming: `season.<feature>.test.js`
- Each test file has its own `beforeEach` deploying fresh contracts (no shared fixtures)
- Helper functions defined inside `describe` blocks: `mintTokensTo`, `approveSeason`, `balancesOf`, `seedSkewedVault`
- Tests deploy mock contracts (MockERC20, MockDex, MockOracle) — never fork mainnet
- Vault ownership transferred to SEASON contract in setup, rebalancer ownership also transferred to SEASON
- Assertions use Chai's `expect(...).to.equal(...)`, `.to.be.gt(...)`, `.to.be.lte(...)`

## Testing Patterns

Tests are organized by feature area:

| File pattern | What it tests |
|---|---|
| `season.mint-burn.test.js` | Deposit/redeem round-trip, rounding dust |
| `season.fees.test.js` | Mint/redeem fee calculation |
| `season.fee-splitting.test.js` | Fee share distribution to feeRecipient |
| `season.invariants*.test.js` | Fund invariants (value conservation, pro-rata) |
| `season.rebalance*.test.js` | Rebalancing strategy, guardrails, events |

When adding tests:
- Create a new file following the `season.<feature>.test.js` naming convention
- Deploy all contracts fresh in `beforeEach` — do not share state between tests
- Use mock contracts, not mainnet forks
- Verify both happy paths and revert conditions

## CI/CD

GitHub Actions runs on push to `main` and all PRs:
1. Install dependencies (`npm ci`)
2. Compile contracts (`npx hardhat compile`)
3. Run full test suite (`npm test`)

No linting or formatting tools are configured. No deployment scripts exist.

## Common Gotchas

- The Hardhat config uses `viaIR: true` which makes compilation slower but produces better-optimized bytecode
- All four token amounts use fixed-size `uint256[4]` arrays — always provide exactly 4 elements
- First depositor seeds the basket ratios; subsequent mints are constrained by the tightest component
- Rebalancer skips silently (emitting events) rather than reverting when conditions aren't met
- MockDex uses deterministic exchange rates set via `setRateE18` — it does not simulate slippage
- Vault `withdrawTo` is owner-only (SEASON), but `transferToken` and `approveToken` accept the operator (rebalancer) too
