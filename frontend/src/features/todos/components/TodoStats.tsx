import { Card, Text } from '../../../design-system'
import { useTodoStatsQuery } from '../hooks/useTodoStatsQuery'

const items = [
  ['total', 'Total'],
  ['active', 'Active'],
  ['completed', 'Completed'],
  ['overdue', 'Overdue'],
] as const

export function TodoStats() {
  const { data, isPending, isError } = useTodoStatsQuery()
  if (isError) return null
  if (isPending)
    return (
      <Text role="status" muted>
        Loading statistics…
      </Text>
    )
  return (
    <Card aria-label="Task statistics">
      <dl className="todo-stats">
        {items.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>{data[key]}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
