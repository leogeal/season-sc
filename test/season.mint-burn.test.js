const { expect } = require("chai");
const { ethers } = require("hardhat");

function bn(x) { return ethers.BigNumber.from(x); }

describe("SEASON: mint then burn redeem", function () {
  let owner, user1, user2;
  let spring, summer, autumn, winter;
  let vault, season;

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address],
      owner.address
    );

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    // Critical: vault ownership to SEASON so it can redeem
    await vault.transferOwnership(season.address);
  });

  async function mintTokensTo(user, amounts) {
    await spring.mint(user.address, amounts[0]);
    await summer.mint(user.address, amounts[1]);
    await autumn.mint(user.address, amounts[2]);
    await winter.mint(user.address, amounts[3]);
  }

  async function approveSeason(user, amounts) {
    await spring.connect(user).approve(season.address, amounts[0]);
    await summer.connect(user).approve(season.address, amounts[1]);
    await autumn.connect(user).approve(season.address, amounts[2]);
    await winter.connect(user).approve(season.address, amounts[3]);
  }

  async function balancesOf(user) {
    return [
      await spring.balanceOf(user.address),
      await summer.balanceOf(user.address),
      await autumn.balanceOf(user.address),
      await winter.balanceOf(user.address),
    ];
  }

  it("initial depositor: mint then burn returns exactly the same underlying (typical case)", async function () {
    const deposit = [
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
    ];

    await mintTokensTo(user1, deposit);
    await approveSeason(user1, deposit);

    const before = await balancesOf(user1);

    await season.connect(user1).mintWithDeposit(deposit);
    const shares = await season.balanceOf(user1.address);

    await season.connect(user1).burnToRedeem(shares);

    const after = await balancesOf(user1);

    // User should be back to original balances (exact), because pro-rata math divides cleanly here.
    for (let i = 0; i < 4; i++) {
      expect(after[i]).to.equal(before[i]);
    }
  });

  it("second depositor: mint then burn returns ~the same underlying (minus rounding dust)", async function () {
    // Seed basket with a not-perfectly-balanced deposit to create rounding scenarios.
    const seed = [
      ethers.utils.parseUnits("123.456789", 18),
      ethers.utils.parseUnits("234.567891", 18),
      ethers.utils.parseUnits("345.678912", 18),
      ethers.utils.parseUnits("456.789123", 18),
    ];

    await mintTokensTo(user1, seed);
    await approveSeason(user1, seed);
    await season.connect(user1).mintWithDeposit(seed);

    // User2 deposits small-ish but still large enough to avoid ROUNDING_TO_ZERO.
    const max2 = [
      ethers.utils.parseUnits("10.0", 18),
      ethers.utils.parseUnits("10.0", 18),
      ethers.utils.parseUnits("10.0", 18),
      ethers.utils.parseUnits("10.0", 18),
    ];

    await mintTokensTo(user2, max2);
    await approveSeason(user2, max2);

    const before2 = await balancesOf(user2);

    // Mint (takes only required amounts; not necessarily all max2)
    await season.connect(user2).mintWithDeposit(max2);
    const shares2 = await season.balanceOf(user2.address);

    // Burn all shares to redeem
    await season.connect(user2).burnToRedeem(shares2);

    const after2 = await balancesOf(user2);

    // User2 should receive back roughly what they paid in.
    // Because both mint and burn round down, they can only lose a small amount to dust.
    // We'll assert each component loss <= 1 wei * 5 (extra slack).
    for (let i = 0; i < 4; i++) {
      expect(after2[i]).to.be.at.most(before2[i]); // can't gain from rounding
      const loss = before2[i].sub(after2[i]);
      expect(loss).to.be.lte(bn(5)); // very tight dust bound in this setup
    }
  });
});
