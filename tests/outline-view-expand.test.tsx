// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OutlineView } from '../components/outline-view';
import type { MindMapNode, MindMapTree } from '../lib/types/mindmap';

/**
 * 树形结构（大纲视图）节点展开/收起功能测试。
 *
 * 结构：
 *   root
 *   ├── 一级节点 A（有子节点）
 *   │   ├── 二级节点 A1（有子节点）
 *   │   │   └── 三级节点 A1a（叶子）
 *   │   └── 二级节点 A2（叶子）
 *   └── 一级节点 B（叶子）
 */

let seq = 0;
function makeNode(id: string, content: string, children: MindMapNode[] = []): MindMapNode {
  const now = ++seq;
  return {
    id,
    content,
    collapsed: false,
    children,
    meta: {
      sourceRef: { type: 'text' as const, text: content },
      confidence: 0.8,
      type: 'detail' as const,
      createdAt: now,
      createdBy: 'ai' as const,
    },
  };
}

function createTree(): MindMapTree {
  const leafA1a = makeNode('node-a1a', '三级节点 A1a');
  const leafA2 = makeNode('node-a2', '二级节点 A2');
  const nodeA1 = makeNode('node-a1', '二级节点 A1', [leafA1a]);
  const nodeA = makeNode('node-a', '一级节点 A', [nodeA1, leafA2]);
  const nodeB = makeNode('node-b', '一级节点 B');

  return {
    id: 'tree-1',
    root: {
      ...makeNode('root', '导图根标题', [nodeA, nodeB]),
      meta: { ...makeNode('root', '').meta, type: 'main' as const, confidence: 1 },
    },
    meta: {
      title: '导图根标题',
      sourceType: 'text',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      truncated: false,
    },
  };
}

function renderOutline(tree: MindMapTree = createTree()) {
  const handlers = {
    onSelectNode: vi.fn(),
    onUpdateNodeContent: vi.fn(),
    onAddChild: vi.fn(() => undefined),
    onAddSibling: vi.fn(() => undefined),
  };
  const utils = render(
    createElement(OutlineView, {
      tree,
      selectedNodeId: null,
      ...handlers,
    }),
  );
  return { ...utils, handlers, tree };
}

function getToggle(label: string): HTMLElement {
  return screen.getByRole('button', { name: label });
}

function getChildrenContainer(nodeId: string): HTMLElement {
  const el = document.getElementById(`outline-children-${nodeId}`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe('OutlineView 展开/收起', () => {
  it('带子节点的行渲染切换按钮，叶子节点不渲染', () => {
    renderOutline();

    // 有子节点：root 的直接子级 A、A1 都有按钮
    expect(getToggle('收起「一级节点 A」的子节点')).toBeInTheDocument();
    expect(getToggle('收起「二级节点 A1」的子节点')).toBeInTheDocument();

    // 叶子节点无按钮
    expect(screen.queryByRole('button', { name: /A1a/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /二级节点 A2/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /一级节点 B/ })).not.toBeInTheDocument();
  });

  it('按钮 ARIA 属性完整：aria-expanded / aria-controls / aria-label', () => {
    renderOutline();

    const toggle = getToggle('收起「一级节点 A」的子节点');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'outline-children-node-a');

    // aria-controls 指向的容器真实存在
    const container = getChildrenContainer('node-a');
    expect(toggle.getAttribute('aria-controls')).toBe(container.id);
  });

  it('收起：隐藏该节点下所有层级后代，按钮状态同步翻转', () => {
    renderOutline();

    const toggle = getToggle('收起「一级节点 A」的子节点');
    fireEvent.click(toggle);

    // 按钮变为展开语义
    expect(getToggle('展开「一级节点 A」的子节点')).toHaveAttribute('aria-expanded', 'false');

    // 子节点容器移除 open 类（CSS 中对应 0fr 高度 + visibility: hidden，隐藏全部后代）
    const container = getChildrenContainer('node-a');
    expect(container).not.toHaveClass('open');

    // 后代（含孙级）的行仍在 DOM 中，但都在已收起容器内，不参与可见布局与可访问性树
    const a1Row = screen.getByText('二级节点 A1').closest('.outline-row');
    const a1aRow = screen.getByText('三级节点 A1a').closest('.outline-row');
    expect(a1Row).not.toBeNull();
    expect(a1aRow).not.toBeNull();
    expect(container.contains(a1Row as Node)).toBe(true);
    expect(container.contains(a1aRow as Node)).toBe(true);
  });

  it('展开：显示直接子节点，深层节点按各自状态独立控制', () => {
    renderOutline();

    // 先收起 A
    fireEvent.click(getToggle('收起「一级节点 A」的子节点'));
    // 再展开 A
    fireEvent.click(getToggle('展开「一级节点 A」的子节点'));

    const containerA = getChildrenContainer('node-a');
    expect(containerA).toHaveClass('open');

    // 直接子节点 A1、A2 可见（其容器 open）
    expect(screen.getByText('二级节点 A1')).toBeInTheDocument();
    expect(screen.getByText('二级节点 A2')).toBeInTheDocument();

    // 收起 A1：仅 A1 后代隐藏，A 的展开状态与 A2 不受影响
    fireEvent.click(getToggle('收起「二级节点 A1」的子节点'));
    expect(getChildrenContainer('node-a')).toHaveClass('open');
    expect(getChildrenContainer('node-a1')).not.toHaveClass('open');
    expect(getToggle('收起「一级节点 A」的子节点')).toHaveAttribute('aria-expanded', 'true');
    expect(getToggle('展开「二级节点 A1」的子节点')).toHaveAttribute('aria-expanded', 'false');
  });

  it('点击按钮不触发行选中', () => {
    const { handlers } = renderOutline();

    fireEvent.click(getToggle('收起「一级节点 A」的子节点'));
    expect(handlers.onSelectNode).not.toHaveBeenCalled();
  });

  it('键盘可用：Enter / Space 触发展开收起', async () => {
    const user = userEvent.setup();
    renderOutline();

    const toggle = getToggle('收起「一级节点 A」的子节点');
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(getToggle('展开「一级节点 A」的子节点')).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard(' ');
    expect(getToggle('收起「一级节点 A」的子节点')).toHaveAttribute('aria-expanded', 'true');
  });

  it('状态一致性：数据更新（重渲染、内容编辑）后收起状态保持', () => {
    const tree = createTree();
    const { rerender } = renderOutline(tree);

    fireEvent.click(getToggle('收起「一级节点 A」的子节点'));
    expect(getChildrenContainer('node-a')).not.toHaveClass('open');

    // 模拟数据更新：同一棵树被编辑（id 不变，内容/版本变化）后重新渲染
    const updatedTree: MindMapTree = {
      ...tree,
      root: {
        ...tree.root,
        children: (tree.root.children ?? []).map((child) =>
          child.id === 'node-a'
            ? { ...child, content: '一级节点 A（已改名）', meta: { ...child.meta, editedAt: 99 } }
            : child,
        ),
      },
      meta: { ...tree.meta, version: tree.meta.version + 1, updatedAt: 99 },
    };

    rerender(
      createElement(OutlineView, {
        tree: updatedTree,
        selectedNodeId: null,
        onSelectNode: vi.fn(),
        onUpdateNodeContent: vi.fn(),
        onAddChild: vi.fn(() => undefined),
        onAddSibling: vi.fn(() => undefined),
      }),
    );

    // 收起状态保持
    const container = getChildrenContainer('node-a');
    expect(container).not.toHaveClass('open');
    expect(
      screen.getByRole('button', { name: '展开「一级节点 A（已改名）」的子节点' }),
    ).toHaveAttribute('aria-expanded', 'false');

    // 收起容器内的内容也应已同步为新内容
    expect(within(container).getByText('二级节点 A1')).toBeInTheDocument();
  });

  it('默认全部展开，且空主题节点按钮文案回退为「空主题」', () => {
    const tree = createTree();
    // 造一个空内容但带子节点的节点
    const firstChild = tree.root.children?.[0];
    expect(firstChild).toBeDefined();
    firstChild!.content = '';
    renderOutline(tree);

    expect(getToggle('收起「空主题」的子节点')).toHaveAttribute('aria-expanded', 'true');
    expect(getChildrenContainer('node-a')).toHaveClass('open');
  });
});
