import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { TONE_STYLES } from '../../lib/classify'
import type { DistributionSlice } from '../../lib/overview'

/** Loaded lazily so Recharts stays out of the first bundle. Decorative: the
 *  parent supplies the accessible description and the legend. */
export default function DriftChart({ slices, total }: { slices: DistributionSlice[]; total: number }) {
  const reduced = useReducedMotion()
  const row: Record<string, number | string> = { name: 'Packages' }
  for (const slice of slices) row[slice.key] = slice.count

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={[row]}
        layout="vertical"
        margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        barCategoryGap={0}
        accessibilityLayer={false}
      >
        <XAxis type="number" hide domain={[0, total]} />
        <YAxis type="category" dataKey="name" hide />
        {slices.map((slice) => (
          <Bar
            key={slice.key}
            dataKey={slice.key}
            stackId="drift"
            fill={TONE_STYLES[slice.tone].cssVar}
            isAnimationActive={!reduced}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}
