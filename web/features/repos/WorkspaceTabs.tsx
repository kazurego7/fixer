import { useMemo } from 'react';
import { useAppCtx } from '../../app/AppContext';

type WorkspaceTabKey = 'chat' | 'files' | 'issues';

interface WorkspaceTabDef {
  key: WorkspaceTabKey;
  label: string;
  path: string;
}

const TABS: WorkspaceTabDef[] = [
  { key: 'chat', label: 'チャット', path: '/chat/' },
  { key: 'files', label: 'ファイル', path: '/files/' },
  { key: 'issues', label: '課題', path: '/issues/' }
];

interface WorkspaceTabsProps {
  active: WorkspaceTabKey;
}

export function WorkspaceTabs({ active }: WorkspaceTabsProps) {
  const { navigateWorkspaceTab, issueItems, gitStatus } = useAppCtx();
  const openIssueCount = useMemo(() => issueItems.filter((item) => item.status !== 'resolved').length, [issueItems]);
  const filesTabState =
    gitStatus?.hasChanges ? (gitStatus.tone === 'danger' ? 'conflict' : 'updated') : 'idle';

  return (
    <nav className="fx-workspace-tabs" aria-label="ワークスペース切り替え" data-testid="workspace-tabs">
      {TABS.map((tab) => {
        const selected = tab.key === active;
        const showCount = tab.key === 'issues' && openIssueCount > 0;
        const statusClass = tab.key === 'files' ? ` is-${filesTabState}` : '';
        return (
          <button
            key={tab.key}
            type="button"
            className={`fx-workspace-tab${selected ? ' is-active' : ''}${statusClass}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => navigateWorkspaceTab(tab.path as '/chat/' | '/files/' | '/issues/')}
            aria-current={selected ? 'page' : undefined}
            title={tab.key === 'files' && gitStatus?.hasChanges ? gitStatus.summary : undefined}
            data-status={tab.key === 'files' ? filesTabState : undefined}
            data-testid={`workspace-tab-${tab.key}`}
          >
            <span>{tab.label}</span>
            {showCount ? <span className="fx-workspace-tab-count">{openIssueCount}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
