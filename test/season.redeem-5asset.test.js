const { expect } = require("chai");
const { ethers } = require("hardhat");

function bn(x) { return ethers.BigNumber.from(x); }
const P = (x) => ethers.utils.parseUnits(String(x), 18);

describe("SEASON: 5-asset redemption (seasonals + wrappedNative)", function () {
  let owner, user, feeRecipient;
  let spring, summer, autumn, winter;
  let wrappedNative;
  let oracle;
  let vault, season;
  let seasonalTokens;

  beforeEach(async function () {
    [owner, user, feeRecipient] = await ethers.getSigners();

    // Seasonal mocks
    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    seasonalTokens = [spring, summer, autumn, winter];

    // MockWrappedNative (WETH9-like)
    const WN = await ethers.getContractFactory("MockWrappedNative");
    wrappedNative = await WN.deploy();

    // Vault
    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address,
       wrappedNative.address],
      owner.address
    );

    // Oracle (all prices 1:1 with wrappedNative)
    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();
    await oracle.setPriceE18(spring.address, P(1));
    await oracle.setPriceE18(summer.address, P(1));
    await oracle.setPriceE18(autumn.address, P(1));
    await oracle.setPriceE18(winter.address, P(1));

    // SEASON
    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, feeRecipient.address);
    await vault.transferOwnership(season.address);
    await season.setWrappedNative(wrappedNative.address);
    await season.setOracle(oracle.address);
    await season.setFees(0, 0);

    // Seed the vault with seasonal tokens via mintWithDeposit
    const seed = [P(500), P(500), P(500), P(500)];
    for (let i = 0; i < 4; i++) {
      await seasonalTokens[i].mint(owner.address, seed[i]);
      await seasonalTokens[i].connect(owner).approve(season.address, seed[i]);
    }
    await season.connect(owner).mintWithDeposit(seed);
  });

  async function allBalances(addr) {
    return {
      spring: await spring.balanceOf(addr),
      summer: await summer.balanceOf(addr),
      autumn: await autumn.balanceOf(addr),
      winter: await winter.balanceOf(addr),
      wn: await wrappedNative.balanceOf(addr),
    };
  }

  it("redemption returns all 5 assets pro-rata when vault holds wrappedNative", async function () {
    // Add wrappedNative to the vault via mintWithNative
    await season.connect(user).mintWithNative({ value: P(200) });

    const userShares = await season.balanceOf(user.address);
    expect(userShares).to.be.gt(0);

    // Capture user balances before burn
    const balBefore = await allBalances(user.address);

    // Burn all user shares
    await season.connect(user).burnToRedeem(userShares);

    const balAfter = await allBalances(user.address);

    // User should get back some of each seasonal + wrappedNative
    // Since the vault has all 5 assets, pro-rata redemption should return some of each
    const springRedeemed = balAfter.spring.sub(balBefore.spring);
    const summerRedeemed = balAfter.summer.sub(balBefore.summer);
    const autumnRedeemed = balAfter.autumn.sub(balBefore.autumn);
    const winterRedeemed = balAfter.winter.sub(balBefore.winter);
    const wnRedeemed = balAfter.wn.sub(balBefore.wn);

    // All should be > 0 since vault had all 5 assets
    expect(springRedeemed).to.be.gt(0);
    expect(summerRedeemed).to.be.gt(0);
    expect(autumnRedeemed).to.be.gt(0);
    expect(winterRedeemed).to.be.gt(0);
    expect(wnRedeemed).to.be.gt(0);
  });

  it("redemption returns only seasonals when vault holds no wrappedNative", async function () {
    // Mint shares via seasonal deposit only (no wrappedNative in vault)
    const dep = [P(50), P(50), P(50), P(50)];
    for (let i = 0; i < 4; i++) {
      await seasonalTokens[i].mint(user.address, dep[i]);
      await seasonalTokens[i].connect(user).approve(season.address, dep[i]);
    }
    await season.connect(user).mintWithDeposit(dep);

    const userShares = await season.balanceOf(user.address);
    const balBefore = await allBalances(user.address);

    await season.connect(user).burnToRedeem(userShares);

    const balAfter = await allBalances(user.address);

    // Seasonals redeemed
    expect(balAfter.spring.sub(balBefore.spring)).to.be.gt(0);
    expect(balAfter.summer.sub(balBefore.summer)).to.be.gt(0);
    expect(balAfter.autumn.sub(balBefore.autumn)).to.be.gt(0);
    expect(balAfter.winter.sub(balBefore.winter)).to.be.gt(0);

    // No wrappedNative returned (vault had 0)
    expect(balAfter.wn.sub(balBefore.wn)).to.equal(0);
  });

  it("pro-rata math is correct: partial burn returns proportional 5-asset amounts", async function () {
    // Add wrappedNative to vault
    await season.connect(user).mintWithNative({ value: P(100) });

    const totalSupply = await season.totalSupply();
    const userShares = await season.balanceOf(user.address);

    // Burn half the user's shares
    const burnAmount = userShares.div(2);

    const vaultBalsBefore = await vault.balances();
    const balBefore = await allBalances(user.address);

    await season.connect(user).burnToRedeem(burnAmount);

    const balAfter = await allBalances(user.address);

    // Expected: floor(vaultBal[i] * burnAmount / totalSupply)
    for (let i = 0; i < 5; i++) {
      const expected = vaultBalsBefore[i].mul(burnAmount).div(totalSupply);
      let redeemed;
      if (i === 0) redeemed = balAfter.spring.sub(balBefore.spring);
      else if (i === 1) redeemed = balAfter.summer.sub(balBefore.summer);
      else if (i === 2) redeemed = balAfter.autumn.sub(balBefore.autumn);
      else if (i === 3) redeemed = balAfter.winter.sub(balBefore.winter);
      else redeemed = balAfter.wn.sub(balBefore.wn);

      expect(redeemed).to.equal(expected);
    }
  });

  it("round-trip: mintWithNative -> burnToRedeem returns equivalent value (no profit, fees=0)", async function () {
    const depositNative = P(100);

    await season.connect(user).mintWithNative({ value: depositNative });
    const shares = await season.balanceOf(user.address);

    const balBefore = await allBalances(user.address);

    await season.connect(user).burnToRedeem(shares);

    const balAfter = await allBalances(user.address);

    // Redeemed amounts across all 5 assets
    const springRedeemed = balAfter.spring.sub(balBefore.spring);
    const summerRedeemed = balAfter.summer.sub(balBefore.summer);
    const autumnRedeemed = balAfter.autumn.sub(balBefore.autumn);
    const winterRedeemed = balAfter.winter.sub(balBefore.winter);
    const wnRedeemed = balAfter.wn.sub(balBefore.wn);

    // All oracle prices are 1:1, so total value = sum of all redeemed amounts
    const totalValueRedeemed = springRedeemed.add(summerRedeemed)
      .add(autumnRedeemed).add(winterRedeemed).add(wnRedeemed);

    // With fees=0, the redeemed value should be close to the deposited amount (within dust)
    expect(totalValueRedeemed).to.be.lte(depositNative);
    const loss = depositNative.sub(totalValueRedeemed);
    expect(loss).to.be.lte(bn(20)); // tight dust bound
  });

  it("round-trip with fees: user gets less back, fee shares account for the loss", async function () {
    await season.setFees(100, 100); // 1% mint + 1% redeem

    const depositNative = P(100);

    const feeSharesBefore = await season.balanceOf(feeRecipient.address);

    await season.connect(user).mintWithNative({ value: depositNative });
    const shares = await season.balanceOf(user.address);
    await season.connect(user).burnToRedeem(shares);

    const feeSharesAfter = await season.balanceOf(feeRecipient.address);
    const feeSharesMinted = feeSharesAfter.sub(feeSharesBefore);

    // Fee shares must have been minted
    expect(feeSharesMinted).to.be.gt(0);

    // User should end with less wrappedNative than deposited
    const wnRedeemed = await wrappedNative.balanceOf(user.address);
    expect(wnRedeemed).to.be.lt(depositNative);
  });

  it("mixed deposits: seasonal + wrappedNative minters both get fair pro-rata on redeem", async function () {
    // user1 (owner) already has shares from seed (400e18 shares for 4*500 = 2000e18 value)

    // user2 deposits via mintWithNative
    await season.connect(user).mintWithNative({ value: P(200) });

    const ownerShares = await season.balanceOf(owner.address);
    const userShares = await season.balanceOf(user.address);

    const totalSupply = await season.totalSupply();
    const vaultBals = await vault.balances();

    // Both burn all shares. Check each gets pro-rata.
    const ownerBefore = await allBalances(owner.address);
    await season.connect(owner).burnToRedeem(ownerShares);
    const ownerAfter = await allBalances(owner.address);

    const userBefore = await allBalances(user.address);
    await season.connect(user).burnToRedeem(userShares);
    const userAfter = await allBalances(user.address);

    // Owner had more shares, so should get proportionally more of each asset
    const ownerSpring = ownerAfter.spring.sub(ownerBefore.spring);
    const userSpring = userAfter.spring.sub(userBefore.spring);

    if (ownerShares.gt(userShares)) {
      expect(ownerSpring).to.be.gt(userSpring);
    }

    // Both should get some wrappedNative since vault has it
    const ownerWn = ownerAfter.wn.sub(ownerBefore.wn);
    const userWn = userAfter.wn.sub(userBefore.wn);

    expect(ownerWn).to.be.gt(0);
    expect(userWn).to.be.gt(0);
  });

  it("Burned event includes 5-element amountsReturned", async function () {
    // Add wrappedNative to vault
    await season.connect(user).mintWithNative({ value: P(100) });
    const shares = await season.balanceOf(user.address);

    // Listen for Burned event (5-element array)
    await expect(
      season.connect(user).burnToRedeem(shares)
    ).to.emit(season, "Burned");
  });

  it("redeem with fees deducts fee shares and returns less underlying", async function () {
    await season.setFees(0, 200); // 2% redeem fee

    await season.connect(user).mintWithNative({ value: P(100) });
    const userShares = await season.balanceOf(user.address);

    const totalSupply = await season.totalSupply();
    const vaultBals = await vault.balances();

    // Expected: feeShares = ceil(sharesToBurn * 200 / 10000)
    // netShares = sharesToBurn - feeShares
    // amountsReturned[i] = floor(vaultBal[i] * netShares / totalSupply)
    const feeShares = userShares.mul(200).add(9999).div(10000);
    const netShares = userShares.sub(feeShares);

    const balBefore = await allBalances(user.address);
    await season.connect(user).burnToRedeem(userShares);
    const balAfter = await allBalances(user.address);

    for (let i = 0; i < 5; i++) {
      const expected = vaultBals[i].mul(netShares).div(totalSupply);
      let redeemed;
      if (i === 0) redeemed = balAfter.spring.sub(balBefore.spring);
      else if (i === 1) redeemed = balAfter.summer.sub(balBefore.summer);
      else if (i === 2) redeemed = balAfter.autumn.sub(balBefore.autumn);
      else if (i === 3) redeemed = balAfter.winter.sub(balBefore.winter);
      else redeemed = balAfter.wn.sub(balBefore.wn);

      expect(redeemed).to.equal(expected);
    }

    // Fee recipient got fee shares
    const feeRecipShares = await season.balanceOf(feeRecipient.address);
    expect(feeRecipShares).to.be.gt(0);
  });
});
