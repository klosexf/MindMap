#!/usr/bin/env node
/**
 * 测试脚本：验证LLM配置和代码执行路径
 * 
 * 运行方式：
 * node scripts/test-llm-path.js
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 手动解析 .env 文件
function loadEnvFile() {
  // 尝试多个可能的路径
  const possiblePaths = [
    resolve(__dirname, '.env'),           // scripts/../.env
    resolve(__dirname, '..', '.env'),     // scripts/../.env (修正)
    process.cwd() + '/.env',              // 当前工作目录
  ];
  
  let envPath = null;
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      envPath = path;
      break;
    }
  }
  
  if (!envPath) {
    console.log('⚠️  未找到 .env 文件');
    console.log('   尝试的路径:', possiblePaths);
    console.log('   当前工作目录:', process.cwd());
    console.log('   脚本目录:', __dirname);
    return;
  }
  
  console.log('✅ 找到 .env 文件:', envPath);
  console.log('');
  
  const envContent = readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // 跳过注释和空行
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // 解析 KEY=VALUE
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();
      
      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      // 设置到 process.env
      process.env[key] = value;
    }
  }
}

// 加载 .env 文件
loadEnvFile();

console.log('========================================');
console.log('LLM 配置测试');
console.log('========================================\n');

// 读取环境变量
const llmProvider = process.env.LLM_PROVIDER || 'openai';
const llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';

console.log('📋 环境变量配置:');
console.log(`  LLM_PROVIDER: ${llmProvider}`);
console.log(`  LLM_MODEL: ${llmModel}`);
console.log('');

// 检查各provider的API Key
const providerKeys = {
  openai: {
    key: process.env.OPENAI_API_KEY,
    keyEnv: 'OPENAI_API_KEY',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
  zhipu: {
    key: process.env.ZHIPU_API_KEY,
    keyEnv: 'ZHIPU_API_KEY',
    baseUrl: process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4',
  },
  kimi: {
    key: process.env.MOONSHOT_API_KEY,
    keyEnv: 'MOONSHOT_API_KEY',
    baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  minimax: {
    key: process.env.MINIMAX_API_KEY,
    keyEnv: 'MINIMAX_API_KEY',
    baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1',
    defaultModel: 'abab6.5-chat',
  },
  qwen: {
    key: process.env.DASHSCOPE_API_KEY,
    keyEnv: 'DASHSCOPE_API_KEY',
    baseUrl: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
  },
  hunyuan: {
    key: process.env.HUNYUAN_API_KEY,
    keyEnv: 'HUNYUAN_API_KEY',
    baseUrl: process.env.HUNYUAN_BASE_URL || 'https://api.hunyuan.cloud.tencent.com/v1',
    defaultModel: 'hunyuan-turbos-latest',
  },
};

console.log('🔑 API Key 配置状态:');
for (const [provider, config] of Object.entries(providerKeys)) {
  const hasKey = Boolean(config.key);
  const keyPreview = hasKey ? `${config.key.substring(0, 12)}...` : '未配置';
  console.log(`  ${provider.padEnd(10)}: ${hasKey ? '✅ 已配置' : '❌ 未配置'} (${config.keyEnv}=${keyPreview})`);
}
console.log('');

// 解析当前配置
const normalizedProvider = {
  moonshot: 'kimi',
  dashscope: 'qwen',
}[llmProvider] || llmProvider;

const providerConfig = providerKeys[normalizedProvider];
const hasApiKey = Boolean(providerConfig?.key);
const isSupported = Boolean(providerConfig);

console.log('📊 路径判断:');
console.log(`  当前Provider: ${llmProvider}`);
console.log(`  标准化Provider: ${normalizedProvider}`);
console.log(`  是否支持: ${isSupported ? '✅ 是' : '❌ 否'}`);
console.log(`  API Key状态: ${hasApiKey ? '✅ 已配置' : '❌ 未配置'}`);
console.log('');

console.log('🚀 预期执行路径:');
if (!isSupported || !hasApiKey) {
  console.log('  ❌ 路径1: 启发式生成（无API Key或provider不支持）');
  console.log('     → 不使用LLM，纯规则生成');
  console.log('     → 不使用任何提示词');
} else if (normalizedProvider === 'openai') {
  console.log('  ✅ 路径2: OpenAI Provider');
  console.log('     → 使用 streamObject() + llmTreeSchema');
  console.log('     → 使用 buildPrompt() 提示词');
  console.log('     → 使用 ANTI_HALLUCINATION_SYSTEM 系统提示');
  console.log('     → 包含完整约束条件、节点组织原则、输出要求');
} else {
  console.log(`  ⚠️  路径3: 非OpenAI Provider (${normalizedProvider})`);
  console.log('     → 使用 generateText() + JSON解析');
  console.log('     → 使用 buildCompatJsonPrompt() 提示词');
  console.log('     → 使用 ANTI_HALLUCINATION_SYSTEM 系统提示');
  console.log('     → ⚠️  缺少约束条件、节点组织原则、输出要求');
}
console.log('');

console.log('📝 使用的模型:');
console.log(`  ${llmModel || providerConfig?.defaultModel || '未知'}`);
console.log('');

console.log('========================================');
console.log('测试完成');
console.log('========================================\n');

// 如果是路径3，给出修复建议
if (isSupported && hasApiKey && normalizedProvider !== 'openai') {
  console.log('💡 修复建议:');
  console.log('   当前使用的是非OpenAI Provider，提示词不完整。');
  console.log('   建议修改 buildCompatJsonPrompt() 函数，补齐以下内容：');
  console.log('   - 约束条件（最大层级、最大节点数、节点文本长度）');
  console.log('   - 节点组织原则（4条规则）');
  console.log('   - 输出要求（3条规则）');
  console.log('');
}
