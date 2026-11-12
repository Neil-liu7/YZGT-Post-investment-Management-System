import { Card, ErrorBox, Loading, useResource } from './components';
import type { Entity } from './api';
import s from './Workspace.module.css';

export function ModelStatusCard() {
  const settings = useResource<Entity>('/settings');
  const status = settings.data?.llm_status;
  const service = status?.host === 'api.deepseek.com' ? 'DeepSeek（兼容接口）' : status?.provider === 'glm' ? '智谱 GLM' : 'Chat Completions 兼容接口';
  return <Card title="AI 提取配置" aside={<button type="button" disabled={settings.loading} onClick={settings.reload}>刷新模型状态</button>}>
    <ErrorBox error={settings.error} retry={settings.reload} />
    {settings.loading ? <Loading /> : status ? <>
      <dl className={s.details}>
        <dt>提取模式</dt><dd>{settings.data?.llm_mode === 'live' ? '真实 AI 提取' : '模拟提取（不外发协议）'}</dd>
        <dt>模型服务</dt><dd>{service}</dd>
        <dt>模型名称</dt><dd>{status.model || '尚未配置'}</dd>
        <dt>接口域名</dt><dd>{status.host || '尚未配置'}</dd>
        <dt>配置检查</dt><dd>{status.configured ? '已通过' : '待补齐配置'}</dd>
        <dt>协议外发</dt><dd>{status.ready ? '已允许向所选模型发送文本' : '未启用真实协议外发'}</dd>
      </dl>
      {!!status.issues?.length && <ul className={s.hint}>{status.issues.map((issue: { code: string; message: string }, index: number) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
    </> : !settings.error && <p className={s.muted}>暂未取得模型配置状态，请刷新后重试。</p>}
    <p className={s.hint}>密钥在本机 .env 中配置，页面仅显示配置状态。修改后重启服务，再刷新状态。使用其他兼容服务时，还需匹配接口地址与模型名称；候选结果始终需要人工审核。</p>
  </Card>;
}
