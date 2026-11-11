/** 一块出错不拖垮整页：把页面里的一块包起来，这块渲染抛错时只在原地显示一句说明，别的块照常。
 *  多用在显示对端回执里来的数据的地方（形状由对端定，可能和约定不一致）。 */
import { Component, type ReactNode } from 'react';
import { Alert } from 'antd';

type Props = { name: string; children: ReactNode };
type State = { error: Error | null };

export default class SectionBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error(`[${this.props.name}] 显示出错`, error); }
  render() {
    if (this.state.error) return <Alert type="warning" showIcon data-testid="section-error"
      message={`「${this.props.name}」这一块显示不出来，其余部分照常`} description={this.state.error.message} />;
    return this.props.children;
  }
}
