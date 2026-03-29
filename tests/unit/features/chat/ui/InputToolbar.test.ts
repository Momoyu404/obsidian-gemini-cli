import { createMockEl } from '@test/helpers/mockElement';

import type { UsageInfo } from '@/core/types';
import { encodeFamilyModel } from '@/core/types';
import {
  ContextUsageMeter,
  createInputToolbar,
  McpServerSelector,
  ModelSelector,
  PermissionToggle,
  ThinkingBudgetSelector,
} from '@/features/chat/ui/InputToolbar';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  setIcon: jest.fn(),
}));

function makeUsage(overrides: Partial<UsageInfo> = {}): UsageInfo {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow: 200000,
    contextTokens: 0,
    percentage: 0,
    ...overrides,
  };
}

function createMockCallbacks(overrides: Record<string, any> = {}) {
  return {
    onModelChange: jest.fn().mockResolvedValue(undefined),
    onThinkingBudgetChange: jest.fn().mockResolvedValue(undefined),
    onPermissionModeChange: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockReturnValue({
      model: 'auto',
      thinkingBudget: 'low',
      permissionMode: 'agent',
    }),
    loadOllamaModels: jest.fn().mockResolvedValue(['qwen3:8b', 'llama3.2:latest']),
    getResolvedModel: jest.fn().mockReturnValue(null),
    ...overrides,
  };
}

function expectHidden(el: any): void {
  expect(el).not.toBeNull();
  expect(el?.hasClass('geminese-hidden')).toBe(true);
}

function expectVisible(el: any): void {
  expect(el).not.toBeNull();
  expect(el?.hasClass('geminese-hidden')).toBe(false);
}

describe('ModelSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ModelSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ModelSelector(parentEl, callbacks);
  });

  it('should create a container with model-selector class', () => {
    const container = parentEl.querySelector('.geminese-model-selector');
    expect(container).not.toBeNull();
  });

  it('should display current model label', () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    expect(btn).not.toBeNull();
    const label = btn?.querySelector('.geminese-model-label');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('Gemini Auto');
  });

  it('should display a Gemini fallback label when current model is unknown', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'nonexistent',
      thinkingBudget: 'low',
      permissionMode: 'agent',
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.geminese-model-label');
    expect(label?.textContent).toBe('Gemini Nonexistent');
  });

  it('should not render a resolved Gemini suffix in the button label', () => {
    callbacks.getResolvedModel.mockReturnValue('auto-gemini-3');
    selector.updateDisplay();

    const btn = parentEl.querySelector('.geminese-model-btn');
    const label = btn?.querySelector('.geminese-model-label');

    expect(label?.textContent).toBe('Gemini Auto');
    expect(btn?.querySelector('.geminese-model-resolved')).toBeNull();
  });

  it('should render family options after opening the dropdown', () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    btn?.click();

    const dropdown = parentEl.querySelector('.geminese-model-dropdown');
    expect(dropdown).not.toBeNull();
    const options = dropdown?.children || [];
    expect(options.length).toBe(2);
    expect(options[0]?.children[0]?.textContent).toBe('Gemini');
    expect(options[1]?.children[0]?.textContent).toBe('Ollama');
  });

  it('should mark the current family as selected in the first menu level', () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    btn?.click();

    const dropdown = parentEl.querySelector('.geminese-model-dropdown');
    const options = dropdown?.children || [];
    const geminiOption = options.find((o: any) => o.children[0]?.textContent === 'Gemini');
    expect(geminiOption?.hasClass('selected')).toBe(true);
  });

  it('should render Gemini submenu options after selecting Gemini family', async () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    btn?.click();

    const dropdown = parentEl.querySelector('.geminese-model-dropdown');
    const options = dropdown?.children || [];
    const geminiOption = options.find((o: any) => o.children[0]?.textContent === 'Gemini');

    await geminiOption?.dispatchEvent('click', { stopPropagation: () => {} });

    const submenuOptions = dropdown?.children || [];
    expect(submenuOptions[0]?.children[0]?.textContent).toBe('‹ Back');
    expect(submenuOptions[1]?.children[0]?.textContent).toBe('Auto');
    expect(submenuOptions[2]?.children[0]?.textContent).toBe('Pro');
    expect(submenuOptions[3]?.children[0]?.textContent).toBe('Flash');
    expect(submenuOptions[4]?.children[0]?.textContent).toBe('Flash Lite');
  });

  it('should call onModelChange when a Gemini option is clicked', async () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    btn?.click();

    const dropdown = parentEl.querySelector('.geminese-model-dropdown');
    const familyOptions = dropdown?.children || [];
    const geminiOption = familyOptions.find((o: any) => o.children[0]?.textContent === 'Gemini');
    await geminiOption?.dispatchEvent('click', { stopPropagation: () => {} });

    const submenuOptions = dropdown?.children || [];
    const proOption = submenuOptions.find((o: any) => o.children[0]?.textContent === 'Pro');

    await proOption?.dispatchEvent('click', { stopPropagation: () => {} });
    await Promise.resolve();

    expect(callbacks.onModelChange).toHaveBeenCalledWith('pro');
  });

  it('should update display when setReady is called', () => {
    selector.setReady(true);
    const btn = parentEl.querySelector('.geminese-model-btn');
    expect(btn?.hasClass('ready')).toBe(true);

    selector.setReady(false);
    expect(btn?.hasClass('ready')).toBe(false);
  });

  it('should show the selected Ollama model label directly', () => {
    callbacks.getSettings.mockReturnValue({
      model: encodeFamilyModel('ollama', 'qwen3:8b'),
      thinkingBudget: 'low',
      permissionMode: 'agent',
    });
    selector.updateDisplay();
    const label = parentEl.querySelector('.geminese-model-label');
    expect(label?.textContent).toBe('qwen3:8b');
  });

  it('should load Ollama models when opening the Ollama submenu', async () => {
    const btn = parentEl.querySelector('.geminese-model-btn');
    btn?.click();

    const dropdown = parentEl.querySelector('.geminese-model-dropdown');
    const familyOptions = dropdown?.children || [];
    const ollamaOption = familyOptions.find((o: any) => o.children[0]?.textContent === 'Ollama');

    await ollamaOption?.dispatchEvent('click', { stopPropagation: () => {} });
    await Promise.resolve();

    expect(callbacks.loadOllamaModels).toHaveBeenCalled();
  });
});

describe('ThinkingBudgetSelector', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let selector: ThinkingBudgetSelector;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    selector = new ThinkingBudgetSelector(parentEl, callbacks);
  });

  it('should create a container with thinking-selector class', () => {
    const container = parentEl.querySelector('.geminese-thinking-selector');
    expect(container).not.toBeNull();
  });

  it('should display Thinking: label', () => {
    const label = parentEl.querySelector('.geminese-thinking-label-text');
    expect(label).toBeNull();
  });

  it('should display current budget label', () => {
    const current = parentEl.querySelector('.geminese-thinking-current');
    expect(current?.textContent).toBe('Low');
  });

  it('should display Off when budget is off', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'off',
      permissionMode: 'agent',
    });
    selector.updateDisplay();
    const current = parentEl.querySelector('.geminese-thinking-current');
    expect(current?.textContent).toBe('Off');
  });

  it('should render budget options in reverse order', () => {
    const options = parentEl.querySelector('.geminese-thinking-options');
    expect(options).not.toBeNull();
    // THINKING_BUDGETS reversed: [xhigh, high, medium, low, off]
    const gears = options?.children || [];
    expect(gears.length).toBe(5);
    expect(gears[0]?.textContent).toBe('Ultra');
    expect(gears[4]?.textContent).toBe('Off');
  });

  it('should mark current budget as selected', () => {
    const options = parentEl.querySelector('.geminese-thinking-options');
    const gears = options?.children || [];
    const lowGear = gears.find((g: any) => g.textContent === 'Low');
    expect(lowGear?.hasClass('selected')).toBe(true);
  });

  it('should call onThinkingBudgetChange when gear clicked', async () => {
    const options = parentEl.querySelector('.geminese-thinking-options');
    const gears = options?.children || [];
    const highGear = gears.find((g: any) => g.textContent === 'High');

    await highGear?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onThinkingBudgetChange).toHaveBeenCalledWith('high');
  });

  it('should set title with token count for non-off budgets', () => {
    const options = parentEl.querySelector('.geminese-thinking-options');
    const gears = options?.children || [];
    const highGear = gears.find((g: any) => g.textContent === 'High');
    expect(highGear?.getAttribute('title')).toContain('16,000 tokens');
  });

  it('should set title as Disabled for off budget', () => {
    const options = parentEl.querySelector('.geminese-thinking-options');
    const gears = options?.children || [];
    const offGear = gears.find((g: any) => g.textContent === 'Off');
    expect(offGear?.getAttribute('title')).toBe('Disabled');
  });
});

describe('PermissionToggle', () => {
  let parentEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    callbacks = createMockCallbacks();
    new PermissionToggle(parentEl, callbacks);
  });

  it('should create a container with permission-selector class', () => {
    const container = parentEl.querySelector('.geminese-permission-selector');
    expect(container).not.toBeNull();
  });

  it('should display Agent label when in agent mode', () => {
    const label = parentEl.querySelector('.geminese-permission-label');
    expect(label?.textContent).toBe('Agent');
  });

  it('should display Plan label when in plan mode', () => {
    callbacks.getSettings.mockReturnValue({
      model: 'sonnet',
      thinkingBudget: 'low',
      permissionMode: 'plan',
    });
    const parentEl2 = createMockEl();
    new PermissionToggle(parentEl2, callbacks);

    const label = parentEl2.querySelector('.geminese-permission-label');
    expect(label?.textContent).toBe('Plan');
  });

  it('should render dropdown options for Plan and Agent', () => {
    const dropdown = parentEl.querySelector('.geminese-permission-dropdown');
    expect(dropdown).not.toBeNull();
    const options = dropdown?.children || [];
    expect(options.length).toBe(2);
  });

  it('should call onPermissionModeChange when option clicked', async () => {
    const dropdown = parentEl.querySelector('.geminese-permission-dropdown');
    const options = dropdown?.children || [];
    const planOption = options.find((o: any) => o.children[0]?.textContent === 'Plan');
    await planOption?.dispatchEvent('click', { stopPropagation: () => {} });
    expect(callbacks.onPermissionModeChange).toHaveBeenCalledWith('plan');
  });
});

describe('McpServerSelector', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should create container with mcp-selector class', () => {
    const container = parentEl.querySelector('.geminese-mcp-selector');
    expect(container).not.toBeNull();
  });

  it('should return empty set of enabled servers initially', () => {
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should hide container when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const container = parentEl.querySelector('.geminese-mcp-selector');
    expectHidden(container);
  });

  it('should show container when servers are configured', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: true }]));
    const container = parentEl.querySelector('.geminese-mcp-selector');
    expectVisible(container);
  });

  it('should show empty message when all servers are disabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'test', enabled: false }]));
    const empty = parentEl.querySelector('.geminese-mcp-selector-empty');
    expect(empty?.textContent).toBe('All MCP servers disabled');
  });

  it('should show no servers message when no servers configured', () => {
    selector.setMcpManager(createMockMcpManager([]));
    const empty = parentEl.querySelector('.geminese-mcp-selector-empty');
    expect(empty?.textContent).toBe('No MCP servers configured');
  });

  it('should add mentioned servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
  });

  it('should not re-render when adding already enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.addMentionedServers(new Set(['server1']));
    const enabledBefore = selector.getEnabledServers();

    selector.addMentionedServers(new Set(['server1']));
    expect(selector.getEnabledServers()).toEqual(enabledBefore);
  });

  it('should clear all enabled servers', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.addMentionedServers(new Set(['server1', 'server2']));
    expect(selector.getEnabledServers().size).toBe(2);

    selector.clearEnabled();
    expect(selector.getEnabledServers().size).toBe(0);
  });

  it('should set enabled servers from array', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    expect(selector.getEnabledServers().size).toBe(2);
  });

  it('should prune enabled servers that no longer exist in manager', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);

    // Now update manager to only have server1
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(selector.getEnabledServers().has('server2')).toBe(false);
  });

  it('should invoke onChange callback when pruning removes servers', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    onChange.mockClear();

    // Prune by removing server2
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    expect(onChange).toHaveBeenCalled();
  });

  it('should show badge when more than 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
      { name: 'server2', enabled: true },
    ]));
    selector.setEnabledServers(['server1', 'server2']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.geminese-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(true);
    expect(badge?.textContent).toBe('2');
  });

  it('should not show badge when only 1 server enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const badge = parentEl.querySelector('.geminese-mcp-selector-badge');
    expect(badge?.hasClass('visible')).toBe(false);
  });

  it('should add active class to icon when servers are enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.setEnabledServers(['server1']);
    selector.updateDisplay();

    const icon = parentEl.querySelector('.geminese-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(true);
  });

  it('should remove active class from icon when no servers enabled', () => {
    selector.setMcpManager(createMockMcpManager([{ name: 'server1', enabled: true }]));
    selector.clearEnabled();
    selector.updateDisplay();

    const icon = parentEl.querySelector('.geminese-mcp-selector-icon');
    expect(icon?.hasClass('active')).toBe(false);
  });

  it('should handle null mcpManager', () => {
    selector.setMcpManager(null);
    expect(selector.getEnabledServers().size).toBe(0);
  });
});

describe('ContextUsageMeter', () => {
  let parentEl: any;
  let meter: ContextUsageMeter;

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    meter = new ContextUsageMeter(parentEl);
  });

  it('should create a container with context-meter class', () => {
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container).not.toBeNull();
  });

  it('should be hidden initially', () => {
    const container = parentEl.querySelector('.geminese-context-meter');
    expectHidden(container);
  });

  it('should remain hidden when update called with null', () => {
    meter.update(null);
    const container = parentEl.querySelector('.geminese-context-meter');
    expectHidden(container);
  });

  it('should remain hidden when contextTokens is 0', () => {
    meter.update(makeUsage({ contextTokens: 0, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expectHidden(container);
  });

  it('should become visible when contextTokens > 0', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expectVisible(container);
  });

  it('should display percentage', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const percent = parentEl.querySelector('.geminese-context-meter-percent');
    expect(percent?.textContent).toBe('25%');
  });

  it('should add warning class when usage > 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.hasClass('warning')).toBe(true);
  });

  it('should remove warning class when usage drops below 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.hasClass('warning')).toBe(false);
  });

  it('should set tooltip with formatted token counts', () => {
    meter.update(makeUsage({ contextTokens: 50000, contextWindow: 200000, percentage: 25 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('50k / 200k');
  });

  it('should format small token counts without k suffix', () => {
    meter.update(makeUsage({ contextTokens: 500, contextWindow: 200000, percentage: 0 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('500 / 200k');
  });

  it('should add compact reminder to tooltip when usage > 80%', () => {
    meter.update(makeUsage({ contextTokens: 170000, contextWindow: 200000, percentage: 85 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('170k / 200k (Approaching limit, run `/compact` to continue)');
  });

  it('should not add compact reminder to tooltip when usage ≤ 80%', () => {
    meter.update(makeUsage({ contextTokens: 160000, contextWindow: 200000, percentage: 80 }));
    const container = parentEl.querySelector('.geminese-context-meter');
    expect(container?.getAttribute('data-tooltip')).toBe('160k / 200k');
  });
});

describe('McpServerSelector - toggle and badges', () => {
  let parentEl: any;
  let selector: McpServerSelector;

  function createMockMcpManager(servers: { name: string; enabled: boolean; contextSaving?: boolean }[] = []) {
    return {
      getServers: jest.fn().mockReturnValue(
        servers.map(s => ({
          name: s.name,
          enabled: s.enabled,
          contextSaving: s.contextSaving ?? false,
        }))
      ),
    } as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    parentEl = createMockEl();
    selector = new McpServerSelector(parentEl);
  });

  it('should render context-saving badge for servers with contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: true },
    ]));

    const csBadge = parentEl.querySelector('.geminese-mcp-selector-cs-badge');
    expect(csBadge).not.toBeNull();
    expect(csBadge?.textContent).toBe('@');
  });

  it('should not render context-saving badge for servers without contextSaving', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true, contextSaving: false },
    ]));

    const csBadge = parentEl.querySelector('.geminese-mcp-selector-cs-badge');
    expect(csBadge).toBeNull();
  });

  it('should toggle server on mousedown and update display', () => {
    const onChange = jest.fn();
    selector.setOnChange(onChange);

    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Find the server item and trigger mousedown
    const item = parentEl.querySelector('.geminese-mcp-selector-item');
    expect(item).not.toBeNull();

    // Simulate mousedown to enable
    const mousedownHandlers = item._eventListeners?.get('mousedown');
    expect(mousedownHandlers).toBeDefined();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(true);
    expect(onChange).toHaveBeenCalled();

    // Toggle again to disable
    onChange.mockClear();
    mousedownHandlers![0]({ preventDefault: jest.fn(), stopPropagation: jest.fn() });

    expect(selector.getEnabledServers().has('server1')).toBe(false);
    expect(onChange).toHaveBeenCalled();
  });

  it('should re-render dropdown on mouseenter', () => {
    selector.setMcpManager(createMockMcpManager([
      { name: 'server1', enabled: true },
    ]));

    // Get container and trigger mouseenter
    const container = parentEl.querySelector('.geminese-mcp-selector');
    const mouseenterHandlers = container?._eventListeners?.get('mouseenter');
    expect(mouseenterHandlers).toBeDefined();

    // Should not throw
    expect(() => mouseenterHandlers![0]()).not.toThrow();
  });
});

describe('createInputToolbar', () => {
  it('should return all toolbar components', () => {
    const parentEl = createMockEl();
    const callbacks = createMockCallbacks();
    const toolbar = createInputToolbar(parentEl, callbacks);

    expect(toolbar.modelSelector).toBeInstanceOf(ModelSelector);
    expect(toolbar.thinkingBudgetSelector).toBeInstanceOf(ThinkingBudgetSelector);
    expect(toolbar.contextUsageMeter).toBeInstanceOf(ContextUsageMeter);
    expect(toolbar.mcpServerSelector).toBeInstanceOf(McpServerSelector);
    expect(toolbar.permissionToggle).toBeInstanceOf(PermissionToggle);
  });
});
