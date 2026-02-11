const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------- deterministic RNG (no external deps) ----------
function xorshift32(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    return x >>> 0;
  };
}

function randInt(rng, lo, hi) {
  const r = rng() % (hi - lo + 1);
  return lo + r;
}

function bn(x) { return ethers.BigNumber.from(x); }

async function bal4(tokens, addr) {
  return Promise.all(tokens.map(t => t.balanceOf(addr)));
}

async function approve4(tokens, ownerSigner, spender, amounts) {
  for (let i = 0; i < 4; i++) {
    await tokens[i].connect(ownerSigner).approve(spender, amounts[i]);
  }
}

async function mint4(tokens, to, amounts) {
  for (let i = 0; i < 4; i++) {
    await tokens[i].mint(to, amounts[i]);
  }
}

describe("SEASON invariants / property tests (with share fees)", function () {
  let owner, u1, u2, u3;
  let spring, summer, autumn, winter;
  let weth;
  let vault, season;
  let tokens;

  beforeEach(async function () {
    [owner, u1, u2, u3] = await ethers.getSigners();

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
    // feeRecipient = owner for tests
    season = await Season.deploy(vault.address, owner.address, owner.address);

    await vault.transferOwnership(season.address);

    // Enable modest fees for invariants
    await season.setFees(50, 50); // 0.50% mint + 0.50% redeem
  });

  async function seedVaultWithUser(userSigner, amounts) {
    await mint4(tokens, userSigner.address, amounts);
    await approve4(tokens, userSigner, season.address, amounts);
    await season.connect(userSigner).mintWithDeposit(amounts);
  }

  it("Invariant A (fees-aware): round-trip cannot increase any underlying balance", async function () {
    // Seed with u1
    const seed = [
      ethers.utils.parseUnits("500", 18),
      ethers.utils.parseUnits("500", 18),
      ethers.utils.parseUnits("500", 18),
      ethers.utils.parseUnits("500", 18),
    ];
    await seedVaultWithUser(u1, seed);

    const rng = xorshift32(0xC0FFEE);
    const TRIALS = 25;

    for (let k = 0; k < TRIALS; k++) {
      const max = [];
      for (let i = 0; i < 4; i++) {
        const whole = randInt(rng, 1, 50);
        max.push(ethers.utils.parseUnits(String(whole), 18));
      }

      await mint4(tokens, u2.address, max);
      await approve4(tokens, u2, season.address, max);

      const before = await bal4(tokens, u2.address);

      await season.connect(u2).mintWithDeposit(max);
      const shares = await season.balanceOf(u2.address);

      // burn all shares
      await season.connect(u2).burnToRedeem(shares);

      const after = await bal4(tokens, u2.address);

      // With fees, they should end with <= before (strictly less in practice).
      for (let i = 0; i < 4; i++) {
        expect(after[i]).to.be.at.most(before[i]);
      }
    }
  });

it("Invariant B (fees-aware): equal shares redeem equal underlying (within rounding dust)", async function () {
  // Seed vault with u1 (non-symmetric)
  const seed = [
    ethers.utils.parseUnits("111.111", 18),
    ethers.utils.parseUnits("222.222", 18),
    ethers.utils.parseUnits("333.333", 18),
    ethers.utils.parseUnits("444.444", 18),
  ];
  await seedVaultWithUser(u1, seed);

  // u2 and u3 identical max deposits
  const max = [
    ethers.utils.parseUnits("20", 18),
    ethers.utils.parseUnits("20", 18),
    ethers.utils.parseUnits("20", 18),
    ethers.utils.parseUnits("20", 18),
  ];

  await mint4(tokens, u2.address, max);
  await mint4(tokens, u3.address, max);

  await approve4(tokens, u2, season.address, max);
  await approve4(tokens, u3, season.address, max);

  // --- Mint ---
  const preMint2 = await bal4(tokens, u2.address);
  const preMint3 = await bal4(tokens, u3.address);

  await season.connect(u2).mintWithDeposit(max);
  await season.connect(u3).mintWithDeposit(max);

  const s2 = await season.balanceOf(u2.address);
  const s3 = await season.balanceOf(u3.address);

  // Burn the same share amount for both (robust even if s2 != s3)
  const burnShares = s2.lt(s3) ? s2 : s3;
  expect(burnShares).to.be.gt(0);

  // Capture balances RIGHT AFTER MINT (before burn), to compute "used"
  const postMint2 = await bal4(tokens, u2.address);
  const postMint3 = await bal4(tokens, u3.address);

  const used2 = postMint2.map((b, i) => preMint2[i].sub(b)); // amounts deposited into vault
  const used3 = postMint3.map((b, i) => preMint3[i].sub(b));

  // --- Burn and compare redeemed deltas ---
  const preBurn2 = await bal4(tokens, u2.address);
  const preBurn3 = await bal4(tokens, u3.address);

  await season.connect(u2).burnToRedeem(burnShares);
  await season.connect(u3).burnToRedeem(burnShares);

  const postBurn2 = await bal4(tokens, u2.address);
  const postBurn3 = await bal4(tokens, u3.address);

  const redeemed2 = postBurn2.map((b, i) => b.sub(preBurn2[i]));
  const redeemed3 = postBurn3.map((b, i) => b.sub(preBurn3[i]));

  // Equal shares burned => equal redeemed (± tiny dust)
  const tol = bn(3);
  for (let i = 0; i < 4; i++) {
    const diff = redeemed2[i].sub(redeemed3[i]).abs();
    expect(diff).to.be.lte(tol);
  }

  // Sanity: redeemed for this burn cannot exceed what they deposited to mint (up to dust)
  // (Since burnShares <= their minted shares)
  const dustTol = bn(20);
  for (let i = 0; i < 4; i++) {
    expect(redeemed2[i]).to.be.at.most(used2[i].add(dustTol));
    expect(redeemed3[i]).to.be.at.most(used3[i].add(dustTol));
  }
});

  it("Invariant C (fees-aware): underlying conservation across vault + users (no rebalance)", async function () {
    // Seed vault with u1; u1 then stays idle.
    const seed = [
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
      ethers.utils.parseUnits("1000", 18),
    ];
    await seedVaultWithUser(u1, seed);

    const rng = xorshift32(0xBADA55);
    const STEPS = 40;

    // Give u2,u3 initial inventories
    const init = [
      ethers.utils.parseUnits("300", 18),
      ethers.utils.parseUnits("300", 18),
      ethers.utils.parseUnits("300", 18),
      ethers.utils.parseUnits("300", 18),
    ];
    await mint4(tokens, u2.address, init);
    await mint4(tokens, u3.address, init);

    // Approve large amounts once
    const big = [
      ethers.utils.parseUnits("1000000", 18),
      ethers.utils.parseUnits("1000000", 18),
      ethers.utils.parseUnits("1000000", 18),
      ethers.utils.parseUnits("1000000", 18),
    ];
    await approve4(tokens, u2, season.address, big);
    await approve4(tokens, u3, season.address, big);

    async function systemTotals() {
      const vb = await vault.balances();
      const b2 = await bal4(tokens, u2.address);
      const b3 = await bal4(tokens, u3.address);
      // feeRecipient may hold shares but not underlying; still, include owner underlying too for completeness:
      const bo = await bal4(tokens, owner.address);

      const tot = [];
      for (let i = 0; i < 4; i++) {
        tot.push(vb[i].add(b2[i]).add(b3[i]).add(bo[i]));
      }
      return tot;
    }

    const beforeTotals = await systemTotals();

    for (let step = 0; step < STEPS; step++) {
      const actor = (rng() % 2 === 0) ? u2 : u3;
      const doMint = (rng() % 100) < 60;

      if (doMint) {
        const bals = await bal4(tokens, actor.address);
        const max = [];
        for (let i = 0; i < 4; i++) {
          const wantWhole = randInt(rng, 1, 20);
          const want = ethers.utils.parseUnits(String(wantWhole), 18);
          max.push(want.lte(bals[i]) ? want : bals[i]);
        }
        if (max.some(x => x.isZero())) continue;

        try {
          await season.connect(actor).mintWithDeposit(max);
        } catch (_) {
          continue;
        }
      } else {
        const shares = await season.balanceOf(actor.address);
        if (shares.isZero()) continue;

        const frac = randInt(rng, 1, 100);
        const burnAmt = shares.mul(frac).div(100);
        if (burnAmt.isZero()) continue;

        await season.connect(actor).burnToRedeem(burnAmt);
      }
    }

    const afterTotals = await systemTotals();

    // Underlying is conserved exactly (no fees in underlying, no rebalance).
    for (let i = 0; i < 4; i++) {
      expect(afterTotals[i]).to.equal(beforeTotals[i]);
    }
  });
});
