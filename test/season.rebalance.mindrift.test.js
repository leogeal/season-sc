const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer guardrail: min drift threshold", function () {
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

    // Dex liquidity
    const big = ethers.utils.parseUnits("1000000", 18);
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(dex.address, big);
    }

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);

    // equal weights
    await rebal.connect(owner).setWeights([2500, 2500, 2500, 2500]);

    // hand ownership to SEASON
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    // disable other guardrails for clarity
    await season.connect(owner).setRebalanceMaxTradeBps(10000);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(0);
    await season.connect(owner).setRebalanceMinTradeAmount(0);
    await season.connect(owner).setFees(0, 0);
  });

  async function deposit(dep) {
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  }

  it("skips rebalance when max drift is below minDriftBps (emits RebalanceSkipped, no swaps)", async function () {
    // Already perfectly on target: 25/25/25/25
    const dep = [
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("100", 18),
    ];
    await deposit(dep);

    // Require at least 1 bps drift; current drift should be 0 -> skip
    await season.connect(owner).setRebalanceMinDriftBps(1);

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const skipped = logs.filter(e => e.name === "RebalanceSkipped");
    const swaps = logs.filter(e => e.name === "SwapExecuted");

    expect(skipped.length).to.equal(1);
    expect(swaps.length).to.equal(0);
  });

  it("performs swaps when max drift is >= minDriftBps", async function () {
    // Skewed deposit -> large drift
    const dep = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("100", 18),
      ethers.utils.parseUnits("50", 18),
      ethers.utils.parseUnits("10", 18),
    ];
    await deposit(dep);

    // Even a large threshold should still allow; but set something modest
    await season.connect(owner).setRebalanceMinDriftBps(50); // 0.50%

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const logs = rcpt.logs
      .filter(l => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map(l => { try { return iface.parseLog(l); } catch { return null; } })
      .filter(Boolean);

    const skipped = logs.filter(e => e.name === "RebalanceSkipped");
    const swaps = logs.filter(e => e.name === "SwapExecuted");

    expect(skipped.length).to.equal(0);
    expect(swaps.length).to.be.gte(1);
  });
});
