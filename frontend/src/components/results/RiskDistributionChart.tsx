import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { RISK_LEVELS, type ReportSummary } from '../../api/types'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { RISK_STYLES } from '../../lib/risk'

interface Props {
  byRisk: ReportSummary['by_risk']
  total: number
}

/** Loaded lazily so Recharts stays out of the first bundle. Decorative: the
 *  parent supplies the accessible description and the legend. */
export default function RiskDistributionChart({ byRisk, total }: Props) {
  const reduced = useReducedMotion()
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={[{ name: 'Drifts', ...byRisk }]}
        layout="vertical"
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        barCategoryGap={0}
        accessibilityLayer={false}
      >
        <XAxis type="number" hide domain={[0, total]} />
        <YAxis type="category" dataKey="name" hide />
        {RISK_LEVELS.map((level) => (
          <Bar
            key={level}
            dataKey={level}
            stackId="risk"
            fill={RISK_STYLES[level].cssVar}
            isAnimationActive={!reduced}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
