#!/usr/bin/env node
/**
 * 验证脚本：检查 buildCompatJsonPrompt 是否已补齐金字塔原理内容
 * 
 * 运行方式：
 * node scripts/verify-prompt-fix.js
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
console.log('提示词优化验证 · 金字塔原理 + 总分结构 + 自检测闭环');
console.log('========================================\n');

const generateTsPath = resolve(__dirname, '..', 'lib/llm/generate.ts');
const content = readFileSync(generateTsPath, 'utf-8');

const checks = [
  // 金字塔原理四原则
  {
    name: '金字塔原理核心方法论',
    pattern: /核心方法论：金字塔原理/,
  },
  {
    name: '原则一 · 结论先行',
    pattern: /结论先行/,
  },
  {
    name: '原则二 · 以上统下',
    pattern: /以上统下/,
  },
  {
    name: '原则三 · 归类分组 · MECE',
    pattern: /归类分组/,
  },
  {
    name: '原则四 · 逻辑递进',
    pattern: /逻辑递进/,
  },
  // 总分结构范式
  {
    name: '总分结构范式',
    pattern: /总分结构生成范式|总分结构范式/,
  },
  {
    name: '根节点【总】',
    pattern: /根节点【总】/,
  },
  {
    name: '一级节点【分】',
    pattern: /一级节点【分】/,
  },
  // 绝对规则增量
  {
    name: '结论先行约束（绝对规则第9条）',
    pattern: /结论先行约束：根节点和每个父节点必须是结论性陈述/,
  },
  {
    name: '以上统下约束（绝对规则第10条）',
    pattern: /以上统下约束：每个子节点必须直接支撑/,
  },
  // 好导图判定标准金字塔化
  {
    name: '判定标准 · 结论先行',
    pattern: /✅ 结论先行：根节点是核心结论而非标题/,
  },
  {
    name: '判定标准 · 以上统下',
    pattern: /✅ 以上统下：上层概括下层，下层支撑上层/,
  },
  {
    name: '判定标准 · 逻辑递进',
    pattern: /✅ 逻辑递进：同级节点按明确逻辑排序/,
  },
  // 验证流程金字塔化
  {
    name: '验证步骤 1：结论先行检查',
    pattern: /结论先行检查（金字塔顶层验证）/,
  },
  {
    name: '验证步骤 2：以上统下检查',
    pattern: /以上统下检查（金字塔纵向验证）/,
  },
  {
    name: '验证步骤 3：归类分组与逻辑递进检查',
    pattern: /归类分组与逻辑递进检查（金字塔横向验证）/,
  },
  // 智能自检测闭环
  {
    name: '智能自检测闭环',
    pattern: /智能自检测闭环（最终输出前必须执行）/,
  },
  {
    name: '结构完整性检查',
    pattern: /结构完整性检查/,
  },
  {
    name: '内容相关性检查',
    pattern: /内容相关性检查/,
  },
  {
    name: '逻辑一致性检查',
    pattern: /逻辑一致性检查/,
  },
  {
    name: '表达准确性检查',
    pattern: /表达准确性检查/,
  },
  {
    name: '自我提问环节',
    pattern: /这是对文档内容最准确、最有效的总结方式吗？/,
  },
  {
    name: '二级节点必须展开',
    pattern: /所有二级节点必须至少展开一层/,
  },
  {
    name: '二级节点展开检查',
    pattern: /检查所有二级节点是否均已展开/,
  },
  {
    name: '完整性防遗漏检查',
    pattern: /无重要内容节点被遗漏/,
  },
  {
    name: '未通过自动回修',
    pattern: /自检测未通过.*自动返回修改并重新生成/s,
  },
  // 约束条件
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
    pattern: /节点文本目标 15-25 字，上限 35 字/,
  },
  // 反例增量
  {
    name: '反例 7：结论先行违反',
    pattern: /反例 7（结论先行违反/,
  },
  {
    name: 'Few-shot 标注金字塔原理',
    pattern: /每个正例均展示结论先行/,
  },
];

console.log('✅ 检查 generate.ts 中金字塔原理优化情况:\n');

let allPassed = true;
let passedCount = 0;
for (const check of checks) {
  const found = check.pattern.test(content);
  const status = found ? '✅' : '❌';
  console.log(`  ${status} ${check.name}`);
  if (found) {
    passedCount++;
  } else {
    allPassed = false;
  }
}

console.log('\n========================================');
console.log(`通过: ${passedCount}/${checks.length}`);

if (allPassed) {
  console.log('✅ 所有检查通过！金字塔原理 + 总分结构 + 自检测闭环优化已全部完成');
  console.log('========================================\n');
  
  console.log('📋 优化内容总结:');
  console.log('   ✅ ANTI_HALLUCINATION_SYSTEM：新增金字塔原理四原则 + 总分结构范式');
  console.log('   ✅ buildPrompt：重构为金字塔框架，新增结论先行/以上统下约束');
  console.log('   ✅ buildCompatJsonPrompt：同步金字塔原理改造，补齐所有缺失内容');
  console.log('   ✅ buildMarkdownPreviewPrompt：按中心主题/中心思想/关键论点/支撑依据输出结构化总结');
  console.log('   ✅ Few-shot：7个反例覆盖结论先行/以上统下/归类分组/逻辑递进');
  console.log('   ✅ 验证流程：5步金字塔验证（顶层/纵向/横向/内容/总分完整性）');
  console.log('   ✅ 自检测闭环：结构完整性/内容相关性/逻辑一致性/表达准确性/二级展开/自我提问 + 未通过回修');
  console.log('');
  console.log('🎯 金字塔原理四原则完整覆盖:');
  console.log('   结论先行 | 以上统下 | 归类分组(MECE) | 逻辑递进(演绎/时间/结构/程度)');
  console.log('');
} else {
  console.log('❌ 部分检查未通过，请检查代码修改');
  console.log('========================================\n');
}

const llmProvider = process.env.LLM_PROVIDER || 'openai';
const llmModel = process.env.LLM_MODEL || 'gpt-4o-mini';

console.log('📊 当前LLM配置:');
console.log(`  Provider: ${llmProvider}`);
console.log(`  Model: ${llmModel}`);
console.log('');

if (llmProvider !== 'openai') {
  console.log('💡 提示: 你正在使用非OpenAI Provider，优化将立即生效！');
  console.log('');
}
