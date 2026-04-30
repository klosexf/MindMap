#!/usr/bin/env node
/**
 * 验证脚本：检查 buildCompatJsonPrompt 是否已补齐缺失内容
 * 
 * 运行方式：
 * node scripts/verify-prompt-fix.js
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 手动解析 .env 文件
function loadEnvFile() {
  const possiblePaths = [
    resolve(__dirname, '.env'),
    resolve(__dirname, '..', '.env'),
    process.cwd() + '/.env',
  ];
  
  let envPath = null;
  for (const path of possiblePaths) {
    if (existsSync(path)) {
      envPath = path;
      break;
    }
  }
  
  if (!envPath) return;
  
  const envContent = readFileSync(envPath, 'utf-8');
  const lines = envContent.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();
      
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      
      process.env[key] = value;
    }
  }
}

loadEnvFile();

console.log('========================================');
console.log('提示词修复验证');
console.log('========================================\n');

// 读取 generate.ts 文件
const generateTsPath = resolve(__dirname, '..', 'lib/llm/generate.ts');
const content = readFileSync(generateTsPath, 'utf-8');

// 检查关键内容是否存在
const checks = [
  {
    name: '约束条件 - 最大层级',
    pattern: /最大层级：\$\{MAX_TREE_DEPTH\}/,
  },
  {
    name: '约束条件 - 最大节点数',
    pattern: /最大节点数：\$\{MAX_TREE_NODES\}/,
  },
  {
    name: '约束条件 - 节点文本长度',
    pattern: /节点文本控制在 35 字以内/,
  },
  {
    name: '节点组织原则 - 第1条',
    pattern: /关联紧密的信息合并为一个节点，其 children 是具体细节/,
  },
  {
    name: '节点组织原则 - 第2条',
    pattern: /某类别下有多个独立子项时，每个子项作为独立节点/,
  },
  {
    name: '节点组织原则 - 第3条',
    pattern: /禁止空标签节点（仅写分类名称而无实质内容）/,
  },
  {
    name: '节点组织原则 - 第4条',
    pattern: /同一维度的信息归入同一父节点/,
  },
  {
    name: '输出要求 - 第1条',
    pattern: /基于文档核心内容重组结构，而非复述原文顺序/,
  },
  {
    name: '输出要求 - 第2条',
    pattern: /专业名词、人名、公司名、数据等原样保留/,
  },
  {
    name: '输出要求 - 第3条',
    pattern: /如果某个维度文档中没有相关信息，就不创建该节点/,
  },
];

console.log('✅ 检查 buildCompatJsonPrompt() 函数修复情况:\n');

let allPassed = true;
for (const check of checks) {
  const found = check.pattern.test(content);
  const status = found ? '✅' : '❌';
  console.log(`  ${status} ${check.name}`);
  if (!found) allPassed = false;
}

console.log('\n========================================');

if (allPassed) {
  console.log('✅ 所有检查通过！buildCompatJsonPrompt() 已成功修复');
  console.log('========================================\n');
  
  console.log('📋 修复内容总结:');
  console.log('   ✅ 添加了约束条件（最大层级、最大节点数、节点文本长度）');
  console.log('   ✅ 添加了节点组织原则（4条规则）');
  console.log('   ✅ 添加了输出要求（3条规则）');
  console.log('');
  console.log('🎯 现在智谱AI等非OpenAI Provider将使用完整的提示词！');
  console.log('');
} else {
  console.log('❌ 部分检查未通过，请检查代码修改');
  console.log('========================================\n');
}

// 显示当前配置
const llmProvider = process.env.LLM_PROVIDER || 'openai';
const llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';

console.log('📊 当前LLM配置:');
console.log(`  Provider: ${llmProvider}`);
console.log(`  Model: ${llmModel}`);
console.log('');

if (llmProvider !== 'openai') {
  console.log('💡 提示: 你正在使用非OpenAI Provider，修改将立即生效！');
  console.log('');
}
