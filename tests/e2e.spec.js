const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

test('主页可用并生成表达句', async ({ page }) => {
  await page.goto('/');

  await page.fill('#observation', '昨晚我们约好 8 点通话，实际 9 点才开始。');
  await page.locator('#feelingChips .chip').first().click();
  await page.locator('#needChips .chip').first().click();
  await page.fill('#request', '你愿意今天晚上九点前回复我吗？');

  await expect(page.locator('#resultText')).toContainText('你愿意');
  await expect(page.locator('#shareLinkBtn')).toBeVisible();
  await expect(page.locator('#shortLinkBtn')).toBeVisible();
});

test('回合模式可记录历史时间轴', async ({ page }) => {
  await page.goto('/');

  await page.click('#roundStartBtn');
  await page.fill('#observation', '昨晚我们约好 8 点通话，实际 9 点才开始。');

  const feelingA = (await page.locator('#feelingChips .chip').first().textContent())?.trim() || '难过';
  const needA = (await page.locator('#needChips .chip').first().textContent())?.trim() || '被看见';
  await page.locator('#feelingChips .chip').first().click();
  await page.locator('#needChips .chip').first().click();
  await page.fill('#request', '你愿意今天九点前回我消息吗？');
  await page.click('#roundLockBtn');

  await expect(page.locator('#echoInput')).toBeEnabled();
  await page.fill('#echoInput', `我听到你说昨晚这件事让你${feelingA}，因为你需要${needA}。`);
  await page.click('#echoConfirmBtn');

  await expect(page.locator('#roundPhase')).toContainText('B 填写中');

  await page.fill('#observation', '我今天开会很多，回复晚了。');
  await page.locator('#feelingChips .chip').nth(1).click();
  await page.locator('#needChips .chip').nth(1).click();
  await page.fill('#request', '你愿意先发一个已读表情给我吗？');
  await page.click('#roundFinishBtn');

  await expect(page.locator('#historyList .history-item').first()).toBeVisible();
  await expect(page.locator('#historyList')).toContainText('第 1 轮');
  await expect(page.locator('#repairList .repair-item').first()).toBeVisible();
  await expect(page.locator('#repairList')).toContainText('来源回合：第 1 轮');
});

test('导出/导入 JSON 含 schemaVersion', async ({ page }) => {
  await page.goto('/');

  await page.fill('#observation', '导出导入测试观察');
  await page.fill('#request', '你愿意晚上十点前回复吗？');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#exportDataBtn')
  ]);

  const tempDir = test.info().outputPath('downloads');
  fs.mkdirSync(tempDir, { recursive: true });
  const savedPath = path.join(tempDir, download.suggestedFilename());
  await download.saveAs(savedPath);

  const exportedData = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
  expect(exportedData.schemaVersion).toBe(2);

  const importPath = path.join(tempDir, 'import.json');
  const importPayload = {
    schemaVersion: 2,
    draft: {
      form: {
        observation: '导入后的观察',
        request: '你愿意今晚先发一句到家了吗？',
        customFeeling: '',
        customNeed: '',
        emotionIntensity: 6,
        selectedFeelings: [],
        selectedNeeds: []
      },
      round: { enabled: false, phase: 'idle', snapshot: null },
      speakerA: 'A',
      speakerB: 'B',
      echoInput: '',
      timer: 180,
      templateCategory: '全部',
      at: Date.now()
    },
    metrics: { sessions: 1, completed: 0, shares: 0, exports: 0, roundSuccess: 0 },
    history: []
  };
  fs.writeFileSync(importPath, JSON.stringify(importPayload), 'utf8');

  await page.setInputFiles('#importDataInput', importPath);
  await expect(page.locator('#observation')).toHaveValue('导入后的观察');
});

test('短链 API 创建和读取', async ({ request }) => {
  const createResp = await request.post('/api/shortlinks', {
    data: {
      state: {
        observation: 'API 测试',
        request: '你愿意回复吗？',
        selectedFeelings: ['难过'],
        selectedNeeds: ['被看见']
      }
    }
  });
  expect(createResp.status()).toBe(201);
  const created = await createResp.json();
  expect(created.id).toBeTruthy();
  expect(created.expiresAt).toBeTruthy();

  const getResp = await request.get(`/api/shortlinks/${created.id}`);
  expect(getResp.status()).toBe(200);
  const loaded = await getResp.json();
  expect(loaded.id).toBe(created.id);
  expect(loaded.state.observation).toBe('API 测试');
});

test('短链 API 支持加密载荷格式', async ({ request }) => {
  const sealed = {
    v: 1,
    alg: 'AES-GCM',
    iv: 'AQIDBAUGBwgJCgsM',
    ct: 'dGVzdC1jaXBoZXJ0ZXh0'
  };
  const createResp = await request.post('/api/shortlinks', {
    data: { sealed }
  });
  expect(createResp.status()).toBe(201);
  const created = await createResp.json();
  expect(created.id).toBeTruthy();

  const getResp = await request.get(`/api/shortlinks/${created.id}`);
  expect(getResp.status()).toBe(200);
  const loaded = await getResp.json();
  expect(loaded.sealed).toBeTruthy();
  expect(loaded.sealed.alg).toBe('AES-GCM');
});

test('短链 API 支持 PIN 与一次性访问', async ({ request }) => {
  const createResp = await request.post('/api/shortlinks', {
    data: {
      state: {
        observation: 'PIN 一次性测试',
        request: '你愿意先说到家了吗？',
        selectedFeelings: ['焦虑'],
        selectedNeeds: ['连接']
      },
      options: {
        pin: '1234',
        oneTime: true
      }
    }
  });
  expect(createResp.status()).toBe(201);
  const created = await createResp.json();
  expect(created.privacy.requiresPin).toBeTruthy();
  expect(created.privacy.maxViews).toBe(1);

  const noPinResp = await request.get(`/api/shortlinks/${created.id}`);
  expect(noPinResp.status()).toBe(401);

  const badPinResp = await request.get(`/api/shortlinks/${created.id}?pin=9999`);
  expect(badPinResp.status()).toBe(403);

  const firstReadResp = await request.get(`/api/shortlinks/${created.id}?pin=1234`);
  expect(firstReadResp.status()).toBe(200);

  const secondReadResp = await request.get(`/api/shortlinks/${created.id}?pin=1234`);
  expect(secondReadResp.status()).toBe(404);
});

test('短链 API 支持续期与克隆', async ({ request }) => {
  const createResp = await request.post('/api/shortlinks', {
    data: {
      state: {
        observation: '续期克隆测试',
        request: '你愿意晚上先发一条消息吗？',
        selectedFeelings: ['紧张'],
        selectedNeeds: ['稳定']
      },
      options: {
        pin: '2026'
      }
    }
  });
  expect(createResp.status()).toBe(201);
  const created = await createResp.json();

  const renewDenied = await request.post(`/api/shortlinks/${created.id}/renew`, {
    data: { days: 60, pin: '0000' }
  });
  expect(renewDenied.status()).toBe(403);

  const renewResp = await request.post(`/api/shortlinks/${created.id}/renew`, {
    data: { days: 60, pin: '2026' }
  });
  expect(renewResp.status()).toBe(200);
  const renewed = await renewResp.json();
  expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(new Date(created.expiresAt).getTime());

  const cloneResp = await request.post(`/api/shortlinks/${created.id}/clone`, {
    data: {
      pin: '2026',
      options: {
        maxViews: 2
      }
    }
  });
  expect(cloneResp.status()).toBe(201);
  const cloned = await cloneResp.json();
  expect(cloned.id).toBeTruthy();
  expect(cloned.id).not.toBe(created.id);

  const clonedRead = await request.get(`/api/shortlinks/${cloned.id}`);
  expect(clonedRead.status()).toBe(200);
  const clonedData = await clonedRead.json();
  expect(clonedData.state.observation).toBe('续期克隆测试');
});

test('新控件可见：协作/待办/隐私分享', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#roomJoinBtn')).toBeVisible();
  await expect(page.locator('#todoAddBtn')).toBeVisible();
  await expect(page.locator('#privacyPin')).toBeVisible();
  await expect(page.locator('#exportReportBtn')).toBeVisible();
  await expect(page.locator('#emotionIntensity')).toBeVisible();
  await expect(page.locator('#reqExecScore')).toBeVisible();
  await expect(page.locator('#repairAddBtn')).toBeVisible();
});

test('请求可执行评分和情绪强度标尺可联动', async ({ page }) => {
  await page.goto('/');

  await page.fill('#request', '你愿意今天晚上九点前回复我吗？');
  await expect(page.locator('#reqExecScore')).toContainText('分');
  await expect(page.locator('#reqExecHint')).toContainText('可执行度');

  await page.fill('#emotionIntensity', '9');
  await expect(page.locator('#emotionIntensityValue')).toContainText('9 / 10');
  await expect(page.locator('#emotionIntensityHint')).toContainText('强度较高');
});
