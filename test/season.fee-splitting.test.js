const { expect } = require("chai");
const { ethers } = require("hardhat");

function ceilDiv(a, b) {
  if (a.isZero()) return a;
  return a.add(b.sub(1)).div(b);
}

describe("SEASON fee splitting (ceil rounding) anti-evasion", function () {
  let owner, user;
  let spring, summer, autumn, winter, tokens;
  let wrappedNative;
  let vault, season;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    wrappedNative = await Mock.deploy("WrappedNative", "WN");   // 5th token (WETH/WPOL)
    tokens = [spring, summer, autumn, winter, wrappedNative];

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address,
       wrappedNative.address],
      owner.address
    );

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.transferOwnership(season.address);

    // Set non-zero fees for this test
    await season.setFees(50, 50); // 0.50% mint and redeem
  });

  async function mint4(to, amounts) {
    for (let i = 0; i < 4; i++) await tokens[i].mint(to, amounts[i]);
  }

  async function approve4(signer, amounts) {
    for (let i = 0; i < 4; i++) await tokens[i].connect(signer).approve(season.address, amounts[i]);
  }

  it("splitting mint into two tx cannot reduce total fee shares vs one tx (ceil rounding)", async function () {
    // First seed the vault so we're not in init mint branch
    const seed = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
    ];
    await mint4(owner.address, seed);
    await approve4(owner, seed);
    await season.connect(owner).mintWithDeposit(seed);

    const feeBps = await season.mintFeeBps();
    const denom = ethers.BigNumber.from(10_000);

    // User deposit budget
    const max = [
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
    ];

    // --- One-shot mint ---
    await mint4(user.address, max);
    await approve4(user, max);

    const feeBeforeOne = await season.balanceOf(owner.address);
    await season.connect(user).mintWithDeposit(max);
    const feeAfterOne = await season.balanceOf(owner.address);
    const oneFeeShares = feeAfterOne.sub(feeBeforeOne);

    // Reset user state by burning all their shares (so we can compare apples-to-apples on fees).
    // Give user approvals and underlying again for split case.
    const userShares1 = await season.balanceOf(user.address);
    await season.connect(user).burnToRedeem(userShares1);

    // --- Split mint into two halves ---
    const half = max.map(x => x.div(2));

    await mint4(user.address, max); // replenish
    await approve4(user, max);

    const feeBeforeSplit = await season.balanceOf(owner.address);

    // Mint half, then half
    await season.connect(user).mintWithDeposit(half);
    await season.connect(user).mintWithDeposit(half);

    const feeAfterSplit = await season.balanceOf(owner.address);
    const splitFeeShares = feeAfterSplit.sub(feeBeforeSplit);

    // Property we want: splitting does not reduce fee shares
    expect(splitFeeShares).to.be.gte(oneFeeShares);

    // Optional stronger check (conceptual):
    // splitFeeShares should be either equal or higher by <= 1 share unit due to rounding-up twice.
    // We can’t tightly bound without knowing grossShares for each tx, but we can assert the difference is small.
    expect(splitFeeShares.sub(oneFeeShares)).to.be.lte(ethers.utils.parseUnits("1", 18));
  });

  it("splitting burn into two tx cannot reduce total fee shares vs one tx (ceil rounding)", async function () {
    // Seed vault and mint user some shares
    const seed = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
    ];
    await mint4(owner.address, seed);
    await approve4(owner, seed);
    await season.connect(owner).mintWithDeposit(seed);

    const max = [
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
      ethers.utils.parseUnits("40", 18),
    ];
    await mint4(user.address, max);
    await approve4(user, max);
    await season.connect(user).mintWithDeposit(max);

    const shares = await season.balanceOf(user.address);
    expect(shares).to.be.gt(0);

    // --- One-shot burn ---
    const feeBeforeOne = await season.balanceOf(owner.address);
    await season.connect(user).burnToRedeem(shares);
    const feeAfterOne = await season.balanceOf(owner.address);
    const oneFeeShares = feeAfterOne.sub(feeBeforeOne);

    // Mint again to set up split burn
    await mint4(user.address, max);
    await approve4(user, max);
    await season.connect(user).mintWithDeposit(max);
    const shares2 = await season.balanceOf(user.address);

    // --- Split burn into two halves ---
    const half1 = shares2.div(2);
    const half2 = shares2.sub(half1);

    const feeBeforeSplit = await season.balanceOf(owner.address);
    await season.connect(user).burnToRedeem(half1);
    await season.connect(user).burnToRedeem(half2);
    const feeAfterSplit = await season.balanceOf(owner.address);

    const splitFeeShares = feeAfterSplit.sub(feeBeforeSplit);

    expect(splitFeeShares).to.be.gte(oneFeeShares);

    // Again, difference should be small in practice; keep this loose but meaningful
    expect(splitFeeShares.sub(oneFeeShares)).to.be.lte(ethers.utils.parseUnits("1", 18));
  });
});
