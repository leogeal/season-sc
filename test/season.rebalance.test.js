const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SEASON rebalancing (module + MockDex)", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal;

beforeEach(async function () {
  [owner, u1] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  spring = await Mock.deploy("SPRING", "SPR");
  summer = await Mock.deploy("SUMMER", "SUM");
  autumn = await Mock.deploy("AUTUMN", "AUT");
  winter = await Mock.deploy("WINTER", "WIN");
  tokens = [spring, summer, autumn, winter];

  const Vault = await ethers.getContractFactory("SeasonVault");
  vault = await Vault.deploy(
    [spring.address, summer.address, autumn.address, winter.address],
    owner.address
  );

  const Dex = await ethers.getContractFactory("MockDex");
  dex = await Dex.deploy(owner.address);

  // 1:1 rates
  const ONE = ethers.utils.parseUnits("1", 18);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      await dex.setRateE18(tokens[i].address, tokens[j].address, ONE);
    }
  }

  // Liquidity to pay outputs
  const big = ethers.utils.parseUnits("1000000", 18);
  for (let i = 0; i < 4; i++) {
    await tokens[i].mint(dex.address, big);
  }

  const Season = await ethers.getContractFactory("SEASON");
  season = await Season.deploy(vault.address, owner.address, owner.address);

  // IMPORTANT: explicitly connect to owner signer (avoids accidental wrong signer)
  await vault.connect(owner).transferOwnership(season.address);

  const Rebal = await ethers.getContractFactory("SeasonRebalancer");
  rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

  // IMPORTANT: set weights BEFORE handing rebalancer ownership to SEASON
  await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

  // Now SEASON owns rebalancer so SEASON.rebalance() can call it
  await rebal.connect(owner).transferOwnership(season.address);

  // Hook
  await season.connect(owner).setRebalancer(rebal.address);
  await season.connect(owner).setVaultOperator(rebal.address);

  await season.connect(owner).setFees(0, 0);
});

  it("rebalances vault holdings close to target weights; conserves total units (1:1 rates)", async function () {
    // Seed the vault with skewed balances via u1 mint deposit
    const dep = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("50", 18),
      ethers.utils.parseUnits("10", 18),
    ];

    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }

    await season.connect(u1).mintWithDeposit(dep);

    const before = await vault.balances();
    const totalBefore = before.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));

    // Target weights: 25/25/25/25 (call via SEASON since SEASON owns the rebalancer)
    await season.connect(owner).setRebalanceWeights([2500, 2500, 2500, 2500]);

    

    // Run rebalance
    await season.rebalance();

    const after = await vault.balances();
    const totalAfter = after.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));

    // With 1:1 mock rates and no fees, total units should be conserved exactly
    expect(totalAfter).to.equal(totalBefore);

    // Each token should be near total/4 (allow small rounding)
    const target = totalAfter.div(4);
    const tol = ethers.utils.parseUnits("1", 18); // 1 token slack for rounding
    for (let i = 0; i < 4; i++) {
      const diff = after[i].sub(target).abs();
      expect(diff).to.be.lte(tol);
    }
  });
});
