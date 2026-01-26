const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SEASON rebalancing (module + MockDex) [expensive -> cheap]", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let vault, season, dex, rebal, oracle;

  const P = (x) => ethers.utils.parseUnits(String(x), 18);

  async function seedSkewedVault() {
    // Skewed toward expensive token (SPRING) to ensure a meaningful trade
    const dep = [P(1000), P(100), P(50), P(10)];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  }

  function sum(arr) {
    return arr.reduce((a, b) => a.add(b), ethers.BigNumber.from(0));
  }

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

    const Oracle = await ethers.getContractFactory("MockOracle");
    oracle = await Oracle.deploy();

    // Prices: SPRING expensive, WINTER cheap
    const prices = [P(4), P(2), P(1), P(0.5)];
    await oracle.setPriceE18(spring.address, prices[0]);
    await oracle.setPriceE18(summer.address, prices[1]);
    await oracle.setPriceE18(autumn.address, prices[2]);
    await oracle.setPriceE18(winter.address, prices[3]);

    // Fair deterministic rates => unit gain possible when selling expensive for cheap
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]);
        await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Liquidity for DEX
    const big = P(1_000_000);
    for (let i = 0; i < 4; i++) await tokens[i].mint(dex.address, big);

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);

    // Vault owned by SEASON
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // Rebalancer owned by SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    // Hook
    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // Configure rebalancer
    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1);
    await season.connect(owner).setRebalanceMinSpreadBps(0);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000); // 10%
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // Keep vault mintable even after repeated trades
    await season.connect(owner).setRebalanceMinComponentBalance(P(1));

    await season.connect(owner).setFees(0, 0);

    await seedSkewedVault();
  });

  it("executes 1 swap (expensive->cheap) and increases raw unit sum in the vault", async function () {
    const before = await vault.balances();
    const totalBefore = sum(before);

    await season.connect(owner).rebalance();

    const after = await vault.balances();
    const totalAfter = sum(after);

    // Raw unit sum should increase because we sell expensive for cheap at fair rates.
    expect(totalAfter).to.be.gt(totalBefore);

    // Specifically SPRING should decrease, WINTER should increase
    expect(after[0]).to.be.lt(before[0]); // SPRING
    expect(after[3]).to.be.gt(before[3]); // WINTER
  });
});
