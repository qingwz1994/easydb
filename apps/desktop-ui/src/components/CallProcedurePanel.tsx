/*
 * Copyright (c) 2024-2026 EasyDB Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */
import React, { useEffect, useState, useCallback } from 'react'
import {
  Modal, Form, Input, InputNumber, Switch, Tabs, Table, Tag,
  Spin, Typography, Space, Alert, Checkbox, Divider, Badge, Tooltip,
  theme,
} from 'antd'
import { PlayCircleOutlined, LoadingOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import type { ProcedureParam, ProcedureInspectResult, ProcedureExecuteResult, ProcedureResultSet } from '@/services/api'
import { procedureApi } from '@/services/api'
import { handleApiError } from '@/utils/notification'

const { Text } = Typography

// ─── 类型感知参数输入组件 ──────────────────────────────────

interface ParamInputProps {
  param: ProcedureParam
  value: string | null
  isNull: boolean
  onChange: (value: string | null) => void
  onNullChange: (isNull: boolean) => void
}

const ParamInput: React.FC<ParamInputProps> = ({ param, value, isNull, onChange }) => {
  const dt = param.dataType.toUpperCase()
  const isOut = param.mode === 'OUT'

  if (isOut) {
    return (
      <Text type="secondary" italic style={{ padding: '4px 8px', background: 'rgba(0,0,0,0.03)', borderRadius: 6, display: 'inline-block' }}>
        执行后显示
      </Text>
    )
  }

  if (isNull) {
    return (
      <Input disabled placeholder="NULL" style={{ opacity: 0.5 }} />
    )
  }

  // BOOLEAN / TINYINT(1)
  if (dt === 'TINYINT' && param.dtdIdentifier?.includes('(1)')) {
    return (
      <Switch
        checked={value === '1'}
        onChange={(checked) => onChange(checked ? '1' : '0')}
        checkedChildren="1 (TRUE)"
        unCheckedChildren="0 (FALSE)"
      />
    )
  }

  // 整数类型
  if (['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT'].includes(dt)) {
    return (
      <InputNumber
        style={{ width: '100%' }}
        precision={0}
        value={value !== null ? Number(value) : undefined}
        onChange={(v) => onChange(v !== null && v !== undefined ? String(v) : null)}
        placeholder={`输入 ${param.dtdIdentifier || dt}`}
      />
    )
  }

  // 小数类型
  if (['DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'REAL'].includes(dt)) {
    return (
      <InputNumber
        style={{ width: '100%' }}
        precision={param.numericScale ?? undefined}
        value={value !== null ? Number(value) : undefined}
        onChange={(v) => onChange(v !== null && v !== undefined ? String(v) : null)}
        placeholder={`输入 ${param.dtdIdentifier || dt}`}
      />
    )
  }

  // 日期
  if (dt === 'DATE') {
    return (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="YYYY-MM-DD"
        maxLength={10}
      />
    )
  }

  // 日期时间
  if (['DATETIME', 'TIMESTAMP'].includes(dt)) {
    return (
      <Input
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="YYYY-MM-DD HH:mm:ss"
        maxLength={19}
      />
    )
  }

  // 默认：文本输入（VARCHAR / TEXT / CHAR / ENUM…）
  return (
    <Input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={`输入 ${param.dtdIdentifier || dt}`}
      allowClear
    />
  )
}

// ─── 参数方向 Tag ─────────────────────────────────────────

const ModeTag: React.FC<{ mode: string }> = ({ mode }) => {
  const colorMap: Record<string, string> = {
    IN: 'blue',
    OUT: 'purple',
    INOUT: 'cyan',
    RETURNS: 'orange',
  }
  return <Tag color={colorMap[mode] ?? 'default'} style={{ minWidth: 52, textAlign: 'center' }}>{mode}</Tag>
}

// ─── 结果集表格 ────────────────────────────────────────────

const ResultSetTable: React.FC<{ rs: ProcedureResultSet }> = ({ rs }) => {
  const columns = rs.columns.map((col) => ({
    title: col,
    dataIndex: col,
    key: col,
    ellipsis: true,
    render: (v: string | null) =>
      v === null ? <Text type="secondary" italic>NULL</Text> : String(v),
  }))
  return (
    <Table
      columns={columns}
      dataSource={rs.rows.map((row, idx) => ({ ...row, _key: idx }))}
      rowKey="_key"
      size="small"
      scroll={{ x: 'max-content', y: 320 }}
      pagination={{
        defaultPageSize: 100,
        hideOnSinglePage: true,
        showTotal: (t) => `共 ${t} 行${rs.rowCount >= 10000 ? '（已截断至 10,000 行上限）' : ''}`,
      }}
    />
  )
}

// ─── 主组件 ───────────────────────────────────────────────

export interface CallProcedureTarget {
  connectionId: string
  database: string
  name: string
  type: 'PROCEDURE' | 'FUNCTION'
}

interface CallProcedurePanelProps {
  target: CallProcedureTarget
  onClose: () => void
}

type Step = 'loading' | 'params' | 'executing' | 'result' | 'error'

interface ParamState {
  value: string | null
  isNull: boolean
}

export const CallProcedurePanel: React.FC<CallProcedurePanelProps> = ({ target, onClose }) => {
  const { token } = theme.useToken()
  const [step, setStep] = useState<Step>('loading')
  const [inspectResult, setInspectResult] = useState<ProcedureInspectResult | null>(null)
  const [execResult, setExecResult] = useState<ProcedureExecuteResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [paramStates, setParamStates] = useState<Record<string, ParamState>>({})

  const isFunction = target.type === 'FUNCTION'

  // Step 0: 自动 inspect
  useEffect(() => {
    setStep('loading')
    setLoadError(null)
    procedureApi.inspect({
      connectionId: target.connectionId,
      database: target.database,
      name: target.name,
      type: target.type,
    }).then((res) => {
      const result = (res as { data: ProcedureInspectResult }).data ?? res as ProcedureInspectResult
      setInspectResult(result)

      // 初始化参数状态
      const init: Record<string, ParamState> = {}
      for (const p of result.params ?? []) {
        if (p.mode !== 'RETURNS') {
          init[p.name] = { value: null, isNull: p.mode === 'OUT' }
        }
      }
      setParamStates(init)
      setStep('params')
    }).catch((e) => {
      setLoadError(e?.message ?? '加载参数元数据失败')
      setStep('error')
    })
  }, [target])

  // 执行
  const handleExecute = useCallback(async () => {
    if (!inspectResult) return
    setStep('executing')

    const execParams = inspectResult.params
      .filter((p) => p.mode !== 'RETURNS')
      .map((p) => ({
        name: p.name,
        value: paramStates[p.name]?.isNull ? null : (paramStates[p.name]?.value ?? null),
        mode: p.mode,
      }))

    try {
      const res = await procedureApi.execute({
        connectionId: target.connectionId,
        database: target.database,
        name: target.name,
        type: target.type,
        params: execParams,
      })
      const result = (res as { data: ProcedureExecuteResult }).data ?? res as ProcedureExecuteResult
      setExecResult(result)
      setStep('result')
    } catch (e) {
      handleApiError(e, '执行失败')
      setStep('params')
    }
  }, [inspectResult, paramStates, target])

  // ─ 渲染参数填写区 ─
  const renderParamsStep = () => {
    const inoutParams = inspectResult?.params.filter((p) => p.mode !== 'RETURNS') ?? []

    if (inoutParams.length === 0) {
      return (
        <Alert
          type="info"
          message={isFunction ? '该函数无需输入参数' : '该存储过程无需输入参数，可直接执行'}
          style={{ marginBottom: 16 }}
        />
      )
    }

    return (
      <Form layout="vertical" style={{ marginTop: 8 }}>
        {inoutParams.map((param) => (
          <Form.Item
            key={param.name}
            label={
              <Space>
                <ModeTag mode={param.mode} />
                <Text strong style={{ fontSize: 13 }}>{param.name}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {param.dtdIdentifier ?? param.dataType}
                </Text>
              </Space>
            }
            style={{ marginBottom: 12 }}
          >
            <Space align="center" style={{ width: '100%' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ParamInput
                  param={param}
                  value={paramStates[param.name]?.value ?? null}
                  isNull={paramStates[param.name]?.isNull ?? false}
                  onChange={(v) => setParamStates((prev) => ({
                    ...prev,
                    [param.name]: { ...prev[param.name], value: v },
                  }))}
                  onNullChange={(isNull) => setParamStates((prev) => ({
                    ...prev,
                    [param.name]: { ...prev[param.name], isNull },
                  }))}
                />
              </div>
              {param.mode !== 'OUT' && (
                <Tooltip title="传 NULL">
                  <Checkbox
                    checked={paramStates[param.name]?.isNull ?? false}
                    onChange={(e) => setParamStates((prev) => ({
                      ...prev,
                      [param.name]: { ...prev[param.name], isNull: e.target.checked },
                    }))}
                  >
                    NULL
                  </Checkbox>
                </Tooltip>
              )}
            </Space>
          </Form.Item>
        ))}
      </Form>
    )
  }

  // ─ 渲染执行结果区 ─
  const renderResult = () => {
    if (!execResult) return null

    const hasOutParams = Object.keys(execResult.outParams ?? {}).length > 0
    const hasResultSets = (execResult.resultSets ?? []).length > 0

    const resultSetItems = (execResult.resultSets ?? []).map((rs) => ({
      key: String(rs.index),
      label: (
        <Space>
          <span>结果集 {rs.index}</span>
          <Badge count={rs.rowCount} style={{ backgroundColor: token.colorPrimary }} showZero overflowCount={9999} />
        </Space>
      ),
      children: <ResultSetTable rs={rs} />,
    }))

    return (
      <div>
        {/* 执行摘要 */}
        <Space style={{ marginBottom: 16 }}>
          {execResult.success ? (
            <CheckCircleOutlined style={{ color: token.colorSuccess, fontSize: 18 }} />
          ) : (
            <CloseCircleOutlined style={{ color: token.colorError, fontSize: 18 }} />
          )}
          <Text strong>{execResult.success ? '执行成功' : '执行失败'}</Text>
          <Text type="secondary">耗时 {execResult.duration} ms</Text>
          {(execResult.warningCount ?? 0) > 0 && (
            <Tag color="warning">{execResult.warningCount} 个警告</Tag>
          )}
        </Space>

        {/* 错误信息 */}
        {execResult.error && (
          <Alert type="error" message={execResult.error} style={{ marginBottom: 16 }} />
        )}

        {/* OUT 参数 */}
        {hasOutParams && (
          <>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>OUT 参数</Text>
            <div style={{
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadius,
              padding: '10px 14px',
              marginBottom: 16,
              fontFamily: 'var(--font-family-code)',
              fontSize: 13,
            }}>
              {Object.entries(execResult.outParams).map(([k, v]) => (
                <div key={k}>
                  <Text type="secondary">{k}</Text>
                  <Text> = </Text>
                  {v === null
                    ? <Text type="secondary" italic>NULL</Text>
                    : <Text strong>{v}</Text>
                  }
                </div>
              ))}
            </div>
          </>
        )}

        {/* 函数返回值（resultSets[0].rows[0].result） */}
        {isFunction && hasResultSets && execResult.resultSets[0]?.columns.includes('result') && (
          <>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>返回值</Text>
            <div style={{
              background: token.colorFillQuaternary,
              borderRadius: token.borderRadius,
              padding: '10px 14px',
              marginBottom: 16,
              fontFamily: 'var(--font-family-code)',
              fontSize: 13,
            }}>
              {execResult.resultSets[0].rows[0]?.['result'] ?? <Text type="secondary" italic>NULL</Text>}
            </div>
            <Divider />
          </>
        )}

        {/* 多结果集 */}
        {hasResultSets && !(isFunction && execResult.resultSets.length === 1 && execResult.resultSets[0]?.columns.includes('result')) && (
          <>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              结果集（共 {execResult.resultSets.length} 个）
            </Text>
            {execResult.resultSets.length === 1 ? (
              <ResultSetTable rs={execResult.resultSets[0]} />
            ) : (
              <Tabs items={resultSetItems} size="small" />
            )}
          </>
        )}

        {!hasOutParams && !hasResultSets && !execResult.error && (
          <Text type="secondary">过程执行成功，无输出参数或结果集</Text>
        )}
      </div>
    )
  }

  // 标题
  const titleIcon = isFunction ? '⨍' : '⚙'
  const titleLabel = isFunction ? '调用函数' : '执行存储过程'

  // 弹窗足迹按钮
  const okText = step === 'params' || step === 'error'
    ? (isFunction ? '调用' : '执行')
    : step === 'result'
    ? '重新执行'
    : '执行中...'

  const handleOk = () => {
    if (step === 'result') {
      setStep('params')
    } else if (step === 'params') {
      handleExecute()
    }
  }

  return (
    <Modal
      open
      title={
        <Space>
          <span style={{ fontSize: 18 }}>{titleIcon}</span>
          <span>{titleLabel}</span>
          <Tag color="purple" style={{ fontFamily: 'var(--font-family-code)', fontSize: 12 }}>
            {target.database}.{target.name}
          </Tag>
        </Space>
      }
      width={680}
      onCancel={onClose}
      onOk={handleOk}
      okText={okText}
      cancelText={step === 'result' ? '关闭' : '取消'}
      okButtonProps={{
        icon: step === 'executing' ? <LoadingOutlined /> : <PlayCircleOutlined />,
        loading: step === 'executing',
        disabled: step === 'loading' || step === 'executing',
        danger: false,
      }}
      destroyOnClose
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
    >
      {/* Step: loading */}
      {step === 'loading' && (
        <div style={{ textAlign: 'center', padding: '40px 0' }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 28 }} spin />} />
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">正在加载参数元数据...</Text>
          </div>
        </div>
      )}

      {/* Step: error (inspect failed) */}
      {step === 'error' && (
        <Alert type="error" message="加载参数元数据失败" description={loadError} showIcon />
      )}

      {/* Step: params / result */}
      {(step === 'params' || step === 'executing' || step === 'result') && inspectResult && (
        <>
          {/* 过程信息摘要 */}
          {inspectResult.comment && (
            <Alert type="info" message={inspectResult.comment} style={{ marginBottom: 16 }} />
          )}
          {inspectResult.definer && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
              DEFINER: {inspectResult.definer}
            </Text>
          )}

          {/* 参数填写区（result 模式也显示，灰化） */}
          {step !== 'result' && renderParamsStep()}

          {/* 执行结果区 */}
          {step === 'result' && renderResult()}
        </>
      )}
    </Modal>
  )
}
