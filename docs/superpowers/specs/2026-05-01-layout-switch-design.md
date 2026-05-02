# 思维导图结构切换功能设计文档

## 概述

为思维导图编辑器添加结构切换功能，支持：
1. **布局方向切换**：左→右、右→左、上→下、下→上
2. **节点拖拽重组**：通过拖拽调整节点的父子关系
3. **一键平衡分布**：将子节点均匀分布到根节点两侧

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      EditorPage                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  EditorToolbar                        │   │
│  │  [结构切换下拉] [平衡按钮] [其他现有按钮...]          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                MindMapEditor                          │   │
│  │  ┌────────────────────────────────────────────────┐  │   │
│  │  │              G6 Graph                          │  │   │
│  │  │  - layout: { type: 'mindmap', direction }     │  │   │
│  │  │  - behaviors: [..., 'drag-node']              │  │   │
│  │  │  - events: node:dragend                       │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              MindMapStore (Zustand)                   │   │
│  │  - layoutDirection: 'LR' | 'RL' | 'TB' | 'BT'       │   │
│  │  - moveNode(nodeId, newParentId, index)             │   │
│  │  - balanceLayout()                                  │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 模块变更

### 1. 类型定义 (`lib/types/mindmap.ts`)

新增布局方向类型：

```typescript
export type LayoutDirection = 'LR' | 'RL' | 'TB' | 'BT';
// LR: Left to Right (左→右，默认)
// RL: Right to Left (右→左)
// TB: Top to Bottom (上→下)
// BT: Bottom to Top (下→上)
```

扩展 TreePatch 类型：

```typescript
export type TreePatch =
  | { type: 'add'; nodeId: string; parentId: string; index: number; node: MindMapNode; timestamp: number }
  | { type: 'update'; nodeId: string; node: Partial<Pick<MindMapNode, 'content' | 'collapsed' | 'style' | 'meta'>>; timestamp: number }
  | { type: 'delete'; nodeId: string; timestamp: number }
  | { type: 'toggleCollapse'; nodeId: string; timestamp: number }
  | { type: 'move'; nodeId: string; newParentId: string; newIndex: number; timestamp: number };
```

### 2. 树操作工具 (`lib/utils/tree.ts`)

新增 `moveNode` 函数：

```typescript
export function moveNode(
  tree: MindMapTree,
  nodeId: string,
  newParentId: string,
  newIndex?: number
): MindMapTree | null;
```

验证规则：
- 不能移动到自身
- 不能移动到自己的子孙节点
- 目标父节点必须存在

新增 `balanceChildren` 函数：

```typescript
export function balanceChildren(tree: MindMapTree): MindMapTree;
```

算法：将根节点的子节点按索引奇偶分成两组，重新组合实现两侧分布。

### 3. G6 工具 (`lib/utils/g6.ts`)

新增布局方向映射：

```typescript
export function getG6LayoutDirection(direction: LayoutDirection): 'LR' | 'RL' | 'TB' | 'BT';
```

### 4. Store (`store/mindmap-store.ts`)

新增状态：

```typescript
interface MindMapState {
  // 现有状态...
  layoutDirection: LayoutDirection;
  
  // 新增 actions
  setLayoutDirection: (direction: LayoutDirection) => void;
  moveNode: (nodeId: string, newParentId: string, index?: number) => void;
  balanceLayout: () => void;
}
```

### 5. 编辑器组件 (`components/mindmap-editor.tsx`)

变更：
- 接收 `layoutDirection` 和 `onMoveNode` props
- Graph layout 配置使用动态 direction
- 启用 `drag-node` behavior
- 监听 `node:dragend` 事件

### 6. 工具栏组件 (`components/editor-toolbar.tsx`)

新增：
- 结构切换下拉菜单（4 个选项）
- 平衡结构按钮

## 数据流

### 布局方向切换

```
用户选择新布局方向
       ↓
EditorToolbar.onLayoutChange
       ↓
EditorPage 调用 store.setLayoutDirection
       ↓
MindMapEditor 接收新 layoutDirection prop
       ↓
useEffect 检测变化，调用 graph.updateLayout()
       ↓
graph.layout() 重新布局
```

### 节点拖拽重组

```
用户拖拽节点到目标节点上
       ↓
G6 触发 node:dragend 事件
       ↓
MindMapEditor 验证拖拽有效性
       ↓
调用 onMoveNode(draggedNodeId, dropTargetId, 0)
       ↓
EditorPage 调用 store.moveNode
       ↓
store.applyPatch({ type: 'move', ... })
       ↓
树结构更新，触发重新渲染
```

### 一键平衡分布

```
用户点击"平衡结构"按钮
       ↓
EditorToolbar.onBalance
       ↓
EditorPage 调用 store.balanceLayout
       ↓
store 更新 tree.root.children 顺序
       ↓
树结构更新，触发重新渲染
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 移动节点到自身 | 静默忽略，不执行操作 |
| 移动节点到自己的子孙 | 静默忽略，返回 null |
| 移动到不存在的父节点 | 静默忽略，返回 null |
| 平衡空树或无子节点的树 | 静默忽略，直接返回原树 |
| 拖拽到无效目标 | 不触发 moveNode，节点回到原位 |
| 拖拽根节点 | 静默忽略 |

## 测试计划

### 单元测试 (`tests/tree-structure.test.ts`)

- `moveNode` 函数
  - 正常移动节点
  - 移动到自身（应失败）
  - 移动到子孙节点（应失败）
  - 移动到不存在的父节点（应失败）
  - 移动到指定索引位置

- `balanceChildren` 函数
  - 空树
  - 单子节点
  - 偶数子节点
  - 奇数子节点

### 集成测试 (`tests/mindmap-editor-structure.test.tsx`)

- 布局方向切换后节点位置正确
- 拖拽节点后树结构更新
- 平衡按钮点击后子节点分布正确

## 边界情况

- 根节点不可移动、不可删除
- 布局切换时保持选中状态
- 当前版本不支持撤销/重做，后续可扩展 TreePatch 历史

## 实现优先级

1. **P0 - 核心功能**
   - 布局方向切换
   - Store 状态扩展
   - 类型定义

2. **P1 - 增强功能**
   - 节点拖拽重组
   - 一键平衡分布

3. **P2 - 测试与优化**
   - 单元测试
   - 集成测试
   - 边界情况处理
