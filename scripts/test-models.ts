import { execSync } from 'node:child_process';

const BIFROST_BASE_URL = 'http://localhost:8080/openai/v1';

interface TestResult {
  modelId: string;
  name: string;
  success: boolean;
  status: string;
  response: string;
  latencyMs: number;
}

function getActiveModels(): { id: string; name?: string }[] {
  try {
    console.log("🔄 Running 'opencode debug config' to extract active models...");
    const output = execSync('opencode debug config', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const config = JSON.parse(output);
    const providers = config?.provider || {};
    const models: { id: string; name?: string }[] = [];

    for (const [providerKey, providerVal] of Object.entries(providers)) {
      const providerModels = (providerVal as any)?.models || {};
      for (const [modelId, modelConfig] of Object.entries(providerModels)) {
        models.push({
          id: modelId,
          name: (modelConfig as any)?.name
        });
      }
    }

    if (models.length > 0) {
      return models;
    }
  } catch (error: any) {
    console.log(`⚠️ Could not read models from 'opencode debug config': ${error.message}`);
  }

  return [];
}

async function testModel(modelId: string): Promise<Omit<TestResult, 'name'>> {
  const startTime = Date.now();
  try {
    const response = await fetch(`${BIFROST_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer dummy-key'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Respond with exactly: PONG' }],
        max_tokens: 150,
        temperature: 0
      }),
      signal: AbortSignal.timeout(12000) // 12 second timeout
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      let parsedErr = '';
      try {
        const json = JSON.parse(errText);
        parsedErr = json.error?.message || json.message || errText;
      } catch {
        parsedErr = errText;
      }
      return {
        modelId,
        success: false,
        status: `HTTP ${response.status}`,
        response: parsedErr.slice(0, 80),
        latencyMs
      };
    }

    const data: any = await response.json();
    const reply = data?.choices?.[0]?.message?.content?.trim() || '';
    
    const matched = reply.toUpperCase().includes('PONG');
    return {
      modelId,
      success: matched,
      status: matched ? 'OK' : 'Unexpected response',
      response: reply,
      latencyMs
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    return {
      modelId,
      success: false,
      status: error.name === 'TimeoutError' ? 'Timeout' : 'Error',
      response: error.message || String(error),
      latencyMs
    };
  }
}

async function run() {
  let activeModels = getActiveModels();

  if (activeModels.length === 0) {
    console.log("🔄 Falling back to Bifrost /v1/models filtered by 'free'...");
    try {
      const response = await fetch(`${BIFROST_BASE_URL}/models`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const resData = (await response.json()) as any;
      const allModels = resData.data || [];
      activeModels = allModels
        .filter((m: any) => m.id.toLowerCase().includes('free'))
        .map((m: any) => ({ id: m.id }));
    } catch (err: any) {
      console.error(`❌ Failed to fetch fallback list: ${err.message}`);
      process.exit(1);
    }
  }

  if (activeModels.length === 0) {
    console.log(`⚠️ No active models found.`);
    return;
  }

  console.log(`🎯 Testing ${activeModels.length} models. Starting ping tests...\n`);
  
  const results: TestResult[] = [];
  
  for (let i = 0; i < activeModels.length; i++) {
    const model = activeModels[i];
    const displayName = model.name || model.id;
    process.stdout.write(`[${i + 1}/${activeModels.length}] Testing "${displayName}"... `);
    
    const result = await testModel(model.id);
    
    if (result.success) {
      console.log(`✅ PONG (in ${result.latencyMs}ms)`);
    } else {
      console.log(`❌ Failed: ${result.status} (${result.response})`);
    }
    
    results.push({
      ...result,
      name: displayName
    });
  }

  console.log(`\n=================== Test Summary ===================`);
  const successCount = results.filter(r => r.success).length;
  console.log(`Success rate: ${successCount}/${activeModels.length} models responded with PONG\n`);
  
  console.table(
    results.map(r => ({
      'Model Name': r.name,
      'Status': r.success ? '✅ OK' : '❌ Failed',
      'Reason': r.status,
      'Raw Reply / Error': r.response.replace(/\n/g, ' '),
      'Latency': `${r.latencyMs}ms`
    }))
  );
}

run();
