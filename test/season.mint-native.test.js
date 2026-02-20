const { expect } = require("chai");
const { ethers } = require("hardhat");

function bn(x) { return ethers.BigNumber.from(x); }
const P = (x) => ethers.utils.parseUnits(String(x), 18);
const ZERO = bn(0);

describe("SEASON: mintWithNative() and mintWithWrappedNative()", function () {
  let owner, user, feeRecipient;
  let spring, summer, autumn, winter;
  let wrappedNative; // MockWrappedNative (has deposit() payable)
  let oracle;
  let vault, season;

  beforeEach(async function () {
    [owner, user, feeRecipient] = await ethers.getSigners();

    // Deploy seasonal mocks
    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");

    // Deploy MockWrappedNative (WETH9-like)
    const WN = await ethers.getContractFactory("MockWrappedNative");
    wrappedNative = await WN.deploy();

    // Vault (5 tokens)
    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address,
       wrappedNative.address],
      owner.address
    );

    // Oracle
    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    // Set oracle prices (base = wrappedNative): seasonal tokens priced in wrappedNative units
    // All 4 seasonals at 1:1 with wrappedNative for simplicity
    await oracle.setPriceE18(spring.address, P(1));
    await oracle.setPriceE18(summer.address, P(1));
    await oracle.setPriceE18(autumn.address, P(1));
    await oracle.setPriceE18(winter.address, P(1));

    // SEASON contract
    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, feeRecipient.address);
    await vault.transferOwnership(season.address);

    // Configure wrappedNative + oracle on SEASON
    await season.setWrappedNative(wrappedNative.address);
    await season.setOracle(oracle.address);

    // No fees by default
    await season.setFees(0, 0);

    // Seed the vault so totalSupply > 0 (required for NAV-based mint paths)
    const seed = [P(100), P(100), P(100), P(100)];
    const tokens = [spring, summer, autumn, winter];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(owner.address, seed[i]);
      await tokens[i].connect(owner).approve(season.address, seed[i]);
    }
    await season.connect(owner).mintWithDeposit(seed);
  });

  // ============================================================
  // mintWithNative() tests
  // ============================================================

  describe("mintWithNative()", function () {
    it("happy path: mints shares proportional to NAV when depositing native", async function () {
      const depositAmount = P(50);

      const supplyBefore = await season.totalSupply();
      const sharesBefore = await season.balanceOf(user.address);
      expect(sharesBefore).to.equal(0);

      await season.connect(user).mintWithNative({ value: depositAmount });

      const sharesAfter = await season.balanceOf(user.address);
      expect(sharesAfter).to.be.gt(0);

      // wrappedNative should have landed in the vault
      const vaultBal = await wrappedNative.balanceOf(vault.address);
      expect(vaultBal).to.equal(depositAmount);
    });

    it("wrappedNative lands in vault, not stuck in SEASON contract", async function () {
      await season.connect(user).mintWithNative({ value: P(10) });

      expect(await wrappedNative.balanceOf(vault.address)).to.equal(P(10));
      expect(await wrappedNative.balanceOf(season.address)).to.equal(0);
    });

    it("mints correct shares based on NAV ratio", async function () {
      // NAV = 4 * 100e18 * 1.0 = 400e18 (all prices = 1, all balances = 100)
      // Supply = 400e18 (from seed mint: sum of deposits)
      // Deposit 400 wrappedNative => grossShares = 400 * 400 / 400 = 400
      const depositAmount = P(400);
      await season.connect(user).mintWithNative({ value: depositAmount });

      const shares = await season.balanceOf(user.address);
      // grossShares = mulDiv(400e18, 400e18, 400e18) = 400e18
      expect(shares).to.equal(P(400));
    });

    it("fee accounting: fee shares go to feeRecipient", async function () {
      await season.setFees(100, 0); // 1% mint fee

      const feeSharesBefore = await season.balanceOf(feeRecipient.address);

      await season.connect(user).mintWithNative({ value: P(100) });

      const userShares = await season.balanceOf(user.address);
      const feeSharesAfter = await season.balanceOf(feeRecipient.address);
      const feeSharesMinted = feeSharesAfter.sub(feeSharesBefore);

      expect(feeSharesMinted).to.be.gt(0);
      // user + fee = gross
      const gross = userShares.add(feeSharesMinted);
      expect(feeSharesMinted).to.equal(gross.mul(100).add(9999).div(10000)); // ceil(gross * 100 / 10000)
    });

    it("reverts with NO_VALUE when msg.value is 0", async function () {
      await expect(
        season.connect(user).mintWithNative({ value: 0 })
      ).to.be.revertedWith("NO_VALUE");
    });

    it("reverts with WRAPPED_NATIVE_NOT_SET when wrappedNative not configured", async function () {
      // Deploy a fresh SEASON without setWrappedNative
      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(vault.address, owner.address, feeRecipient.address);

      // Need oracle set but not wrappedNative
      await season2.setOracle(oracle.address);

      await expect(
        season2.connect(user).mintWithNative({ value: P(1) })
      ).to.be.revertedWith("WRAPPED_NATIVE_NOT_SET");
    });

    it("reverts with ORACLE_NOT_SET when oracle not configured", async function () {
      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(vault.address, owner.address, feeRecipient.address);
      await season2.setWrappedNative(wrappedNative.address);

      await expect(
        season2.connect(user).mintWithNative({ value: P(1) })
      ).to.be.revertedWith("ORACLE_NOT_SET");
    });

    it("reverts with INIT_USE_MINTWITHDEPOSIT when totalSupply is 0", async function () {
      // Deploy a fresh vault+season with no initial deposit
      const Mock = await ethers.getContractFactory("MockERC20");
      const s = await Mock.deploy("S", "S");
      const u = await Mock.deploy("U", "U");
      const a = await Mock.deploy("A", "A");
      const w = await Mock.deploy("W", "W");

      const Vault = await ethers.getContractFactory("SeasonVault");
      const v2 = await Vault.deploy(
        [s.address, u.address, a.address, w.address, wrappedNative.address],
        owner.address
      );

      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(v2.address, owner.address, feeRecipient.address);
      await v2.transferOwnership(season2.address);
      await season2.setWrappedNative(wrappedNative.address);
      await season2.setOracle(oracle.address);

      await expect(
        season2.connect(user).mintWithNative({ value: P(1) })
      ).to.be.revertedWith("INIT_USE_MINTWITHDEPOSIT");
    });

    it("receive() rejects raw ETH sent without calling mintWithNative", async function () {
      await expect(
        user.sendTransaction({ to: season.address, value: P(1) })
      ).to.be.revertedWith("USE_MINTWITHNATIVE");
    });

    it("emits MintedWithWrappedNative event", async function () {
      await expect(
        season.connect(user).mintWithNative({ value: P(50) })
      ).to.emit(season, "MintedWithWrappedNative");
    });

    it("multiple mints accumulate correctly", async function () {
      await season.connect(user).mintWithNative({ value: P(10) });
      const shares1 = await season.balanceOf(user.address);

      await season.connect(user).mintWithNative({ value: P(10) });
      const shares2 = await season.balanceOf(user.address);

      expect(shares2).to.be.gt(shares1);
      expect(await wrappedNative.balanceOf(vault.address)).to.equal(P(20));
    });
  });

  // ============================================================
  // mintWithWrappedNative() tests
  // ============================================================

  describe("mintWithWrappedNative()", function () {
    it("happy path: pulls wrappedNative from user and mints shares", async function () {
      // Give user some wrappedNative (via the test mint helper)
      await wrappedNative.mint(user.address, P(100));
      await wrappedNative.connect(user).approve(season.address, P(100));

      await season.connect(user).mintWithWrappedNative(P(100));

      const shares = await season.balanceOf(user.address);
      expect(shares).to.be.gt(0);

      // wrappedNative lands in vault
      expect(await wrappedNative.balanceOf(vault.address)).to.equal(P(100));
      expect(await wrappedNative.balanceOf(user.address)).to.equal(0);
    });

    it("mints correct shares based on NAV ratio", async function () {
      // Same NAV calculation as mintWithNative test
      await wrappedNative.mint(user.address, P(400));
      await wrappedNative.connect(user).approve(season.address, P(400));

      await season.connect(user).mintWithWrappedNative(P(400));

      const shares = await season.balanceOf(user.address);
      expect(shares).to.equal(P(400));
    });

    it("fee accounting: fee shares go to feeRecipient", async function () {
      await season.setFees(200, 0); // 2% mint fee

      await wrappedNative.mint(user.address, P(100));
      await wrappedNative.connect(user).approve(season.address, P(100));

      const feeSharesBefore = await season.balanceOf(feeRecipient.address);

      await season.connect(user).mintWithWrappedNative(P(100));

      const userShares = await season.balanceOf(user.address);
      const feeSharesAfter = await season.balanceOf(feeRecipient.address);
      const feeSharesMinted = feeSharesAfter.sub(feeSharesBefore);

      expect(feeSharesMinted).to.be.gt(0);
      expect(userShares).to.be.gt(0);
    });

    it("reverts with NO_WRAPPED_NATIVE when amount is 0", async function () {
      await expect(
        season.connect(user).mintWithWrappedNative(0)
      ).to.be.revertedWith("NO_WRAPPED_NATIVE");
    });

    it("reverts with WRAPPED_NATIVE_NOT_SET when not configured", async function () {
      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(vault.address, owner.address, feeRecipient.address);
      await season2.setOracle(oracle.address);

      await expect(
        season2.connect(user).mintWithWrappedNative(P(1))
      ).to.be.revertedWith("WRAPPED_NATIVE_NOT_SET");
    });

    it("reverts with ORACLE_NOT_SET when oracle not configured", async function () {
      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(vault.address, owner.address, feeRecipient.address);
      await season2.setWrappedNative(wrappedNative.address);

      await expect(
        season2.connect(user).mintWithWrappedNative(P(1))
      ).to.be.revertedWith("ORACLE_NOT_SET");
    });

    it("reverts with INIT_USE_MINTWITHDEPOSIT when totalSupply is 0", async function () {
      const Mock = await ethers.getContractFactory("MockERC20");
      const s = await Mock.deploy("S", "S");
      const u = await Mock.deploy("U", "U");
      const a = await Mock.deploy("A", "A");
      const w = await Mock.deploy("W", "W");

      const Vault = await ethers.getContractFactory("SeasonVault");
      const v2 = await Vault.deploy(
        [s.address, u.address, a.address, w.address, wrappedNative.address],
        owner.address
      );

      const Season = await ethers.getContractFactory("SEASON");
      const season2 = await Season.deploy(v2.address, owner.address, feeRecipient.address);
      await v2.transferOwnership(season2.address);
      await season2.setWrappedNative(wrappedNative.address);
      await season2.setOracle(oracle.address);

      await wrappedNative.mint(user.address, P(10));
      await wrappedNative.connect(user).approve(season2.address, P(10));

      await expect(
        season2.connect(user).mintWithWrappedNative(P(10))
      ).to.be.revertedWith("INIT_USE_MINTWITHDEPOSIT");
    });

    it("emits MintedWithWrappedNative event", async function () {
      await wrappedNative.mint(user.address, P(50));
      await wrappedNative.connect(user).approve(season.address, P(50));

      await expect(
        season.connect(user).mintWithWrappedNative(P(50))
      ).to.emit(season, "MintedWithWrappedNative");
    });
  });

  // ============================================================
  // NAV with non-uniform prices
  // ============================================================

  describe("NAV correctness with non-uniform oracle prices", function () {
    it("wrappedNative deposit at 2x price yields half the shares of equal-value seasonal deposit", async function () {
      // Set SPRING price to 2 wrappedNative per 1 SPRING
      await oracle.setPriceE18(spring.address, P(2));
      await oracle.setPriceE18(summer.address, P(2));
      await oracle.setPriceE18(autumn.address, P(2));
      await oracle.setPriceE18(winter.address, P(2));

      // Now NAV = sum_i(balance[i] * price[i]) + wrappedNativeBal
      // = 4 * 100 * 2 + 0 = 800 wrappedNative
      // Supply = 400e18
      // Deposit 400 wrappedNative => grossShares = 400 * 400 / 800 = 200
      await season.connect(user).mintWithNative({ value: P(400) });

      const shares = await season.balanceOf(user.address);
      expect(shares).to.equal(P(200));
    });
  });
});
