const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SEASON fee logic (shares-based)", function () {
  let owner, user;
  let spring, summer, autumn, winter, tokens;
  let weth;
  let vault, season;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const Mock = await ethers.getContractFactory("MockERC20");
    spring = await Mock.deploy("SPRING", "SPR");
    summer = await Mock.deploy("SUMMER", "SUM");
    autumn = await Mock.deploy("AUTUMN", "AUT");
    winter = await Mock.deploy("WINTER", "WIN");
    weth   = await Mock.deploy("WETH", "WETH");   // new 5th token
    tokens = [spring, summer, autumn, winter, weth];

    const Vault = await ethers.getContractFactory("SeasonVault");
    vault = await Vault.deploy(
      [spring.address, summer.address, autumn.address, winter.address,
       weth.address],
      owner.address
    );

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    await vault.transferOwnership(season.address);
  });

  async function mint4(to, amounts) {
    for (let i = 0; i < 4; i++) await tokens[i].mint(to, amounts[i]);
  }

  async function approve4(signer, amounts) {
    for (let i = 0; i < 4; i++) await tokens[i].connect(signer).approve(season.address, amounts[i]);
  }

  it("mint fee: user receives fewer shares, feeRecipient receives fee shares (ceil rounding)", async function () {
    await season.setFees(50, 0); // 0.50% mint fee

    const dep = [
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
    ];

    await mint4(user.address, dep);
    await approve4(user, dep);

    const totalBefore = await season.totalSupply();
    expect(totalBefore).to.equal(0);

    await season.connect(user).mintWithDeposit(dep);

    const userShares = await season.balanceOf(user.address);
    const feeShares = await season.balanceOf(owner.address);

    // grossShares = sum(dep) = 1000e18
    const gross = ethers.utils.parseUnits("1000", 18);

    // fee = ceil(gross * 50 / 10000)
    const expectedFee = gross.mul(50).add(9999).div(10000);
    const expectedUser = gross.sub(expectedFee);

    expect(userShares).to.equal(expectedUser);
    expect(feeShares).to.equal(expectedFee);
    expect(await season.totalSupply()).to.equal(gross);
  });

  it("redeem fee: user pays fee in shares; underlying redeemed corresponds to net shares", async function () {
    await season.setFees(0, 100); // 1% redeem fee

    // Seed by user with no mint fee
    const dep = [
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
      ethers.utils.parseUnits("250", 18),
    ];

    await mint4(user.address, dep);
    await approve4(user, dep);
    await season.connect(user).mintWithDeposit(dep);

    const shares = await season.balanceOf(user.address);

    // burn all shares (redeem fee charged)
    await season.connect(user).burnToRedeem(shares);

    // After redeem, feeRecipient should hold some shares (fee minted)
    const feeShares = await season.balanceOf(owner.address);
    expect(feeShares).to.be.gt(0);

    // user shares should be 0
    expect(await season.balanceOf(user.address)).to.equal(0);
  });
});
