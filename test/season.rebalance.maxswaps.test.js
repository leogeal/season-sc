const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SeasonRebalancer guardrail: max swaps per rebalance", function () {
  let owner, u1;
  let spring, summer, autumn, winter, tokens;
  let wrappedNative;
  let vault, season, dex, rebal, oracle;

  const P = (x) => ethers.utils.parseUnits(String(x), 18);

  async function seedSkewedVault() {
    const dep = [P(1000), P(50), P(50), P(50)];
    for (let i = 0; i < 4; i++) {
      await tokens[i].mint(u1.address, dep[i]);
      await tokens[i].connect(u1).approve(season.address, dep[i]);
    }
    await season.connect(u1).mintWithDeposit(dep);
  }

  beforeEach(async function () {
    [owner, u1] = await ethers.getSigners();

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

    // Fair deterministic rates: rate(in->out) = priceIn/priceOut
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const r = prices[i].mul(ethers.constants.WeiPerEther).div(prices[j]);
        await dex.setRateE18(tokens[i].address, tokens[j].address, r);
      }
    }

    // Fund DEX
    const big = P(1_000_000);
    for (let i = 0; i < 4; i++) await tokens[i].mint(dex.address, big);

    const Season = await ethers.getContractFactory("SEASON");
    season = await Season.deploy(vault.address, owner.address, owner.address);
    await vault.connect(owner).transferOwnership(season.address);

    const Rebal = await ethers.getContractFactory("SeasonRebalancer");
    rebal = await Rebal.deploy(vault.address, dex.address, owner.address);
    await rebal.connect(owner).transferOwnership(season.address);

    await season.connect(owner).setRebalancer(rebal.address);
    await season.connect(owner).setVaultOperator(rebal.address);

    await season.connect(owner).setRebalanceOracle(oracle.address);
    await season.connect(owner).setRebalanceMinUnitGainBps(1);
    await season.connect(owner).setRebalanceMinSpreadBps(0);
    await season.connect(owner).setRebalanceCooldownSeconds(0);
    await season.connect(owner).setRebalanceMaxTradeBps(1000);
    await season.connect(owner).setRebalanceMinTradeAmount(0);

    // keep vault mintable
    await season.connect(owner).setRebalanceMinComponentBalance(P(1));

    await season.connect(owner).setFees(0, 0);

    await seedSkewedVault();
  });

  it("reverts when maxSwapsPerRebalance is too low for required swaps", async function () {
    // Strategy requires 1 swap. Set maxSwaps = 0 => should block.
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(0);

    let threw = false;
    try {
      await season.connect(owner).rebalance();
    } catch (e) {
      threw = true;
      expect(e.message).to.include("MaxSwapsTooLow");
    }
    expect(threw).to.equal(true);
  });

  it("suc hookup: succeeds when maxSwapsPerRebalance is >= 1; emits <= max swaps", async function () {
    await season.connect(owner).setRebalanceMaxSwapsPerRebalance(1);

    const tx = await season.connect(owner).rebalance();
    const rcpt = await tx.wait();

    const iface = rebal.interface;
    const parsed = rcpt.logs
      .filter((l) => l.address.toLowerCase() === rebal.address.toLowerCase())
      .map((l) => {
        try { return iface.parseLog(l); } catch { return null; }
      })
      .filter(Boolean);

    const swaps = parsed.filter((e) => e.name === "SwapExecuted");
    expect(swaps.length).to.be.at.most(1);
    expect(swaps.length).to.equal(1); // with our setup it should execute
  });
});
