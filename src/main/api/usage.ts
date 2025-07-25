import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { glob } from 'glob'

/**
 * Usage tracking and statistics
 */
export interface UsageEntry {
  timestamp: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  cost: number
  session_id: string
  project_path: string
  request_id?: string // API 请求 ID，用于去重
  message_type?: string // 消息类型 (user/assistant)
}

export interface UsageStats {
  total_cost: number
  total_tokens: number
  total_input_tokens: number
  total_output_tokens: number
  total_cache_creation_tokens: number
  total_cache_read_tokens: number
  total_sessions: number
  total_requests: number // API 请求数（用于计算平均成本）
  by_model: ModelUsage[]
  by_date: DailyUsage[]
  by_project: ProjectUsage[]
}

export interface ModelUsage {
  model: string
  total_cost: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  session_count: number
  request_count: number // API 请求数
}

export interface DailyUsage {
  date: string
  total_cost: number
  total_tokens: number
  models_used: string[]
}

export interface ProjectUsage {
  project_path: string
  project_name: string
  total_cost: number
  total_tokens: number
  session_count: number
  request_count: number // API 请求数
  last_used: string
}

// Claude 4 pricing constants (per million tokens)
const PRICING = {
  'opus-4': {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  'sonnet-4': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  'haiku-4': {
    input: 1.0,
    output: 5.0,
    cache_write: 1.25,
    cache_read: 0.1
  },
  // Versioned models (e.g., claude-sonnet-4-20250514)
  claudeopus420250514: {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  claudesonnet420250514: {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  claudehaiku420250514: {
    input: 1.0,
    output: 5.0,
    cache_write: 1.25,
    cache_read: 0.1
  },
  // Legacy models
  opus: {
    input: 15.0,
    output: 75.0,
    cache_write: 18.75,
    cache_read: 1.5
  },
  sonnet: {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.3
  },
  haiku: {
    input: 1.0,
    output: 5.0,
    cache_write: 1.25,
    cache_read: 0.1
  },
  // Synthetic messages (no cost)
  synthetic: {
    input: 0,
    output: 0,
    cache_write: 0,
    cache_read: 0
  }
}

/**
 * Usage Statistics IPC handlers
 */
export function setupUsageHandlers() {
  // Get usage statistics for a date range
  ipcMain.handle(
    'get-usage-stats',
    async (
      _,
      params?: {
        startDate?: string
        endDate?: string
        projectPath?: string
      }
    ) => {
      const { startDate, endDate, projectPath } = params || {}
      console.log('Main: get-usage-stats called with', { startDate, endDate, projectPath })
      try {
        return await getUsageStats(startDate, endDate, projectPath)
      } catch (error) {
        console.error('Error getting usage stats:', error)
        return {
          total_cost: 0,
          total_tokens: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cache_creation_tokens: 0,
          total_cache_read_tokens: 0,
          total_sessions: 0,
          total_requests: 0,
          by_model: [],
          by_date: [],
          by_project: []
        }
      }
    }
  )

  // Get usage entries for a specific session
  ipcMain.handle('get-session-usage', async (_, sessionId: string) => {
    console.log('Main: get-session-usage called with', sessionId)
    try {
      return await getSessionUsage(sessionId)
    } catch (error) {
      console.error('Error getting session usage:', error)
      return []
    }
  })

  // Get daily usage statistics
  ipcMain.handle('get-daily-usage', async (_, date?: string) => {
    console.log('Main: get-daily-usage called with', date)
    try {
      const targetDate = date || new Date().toISOString().split('T')[0]
      const stats = await getUsageStats(targetDate, targetDate)
      return (
        stats.by_date[0] || {
          date: targetDate,
          total_cost: 0,
          total_tokens: 0,
          models_used: []
        }
      )
    } catch (error) {
      console.error('Error getting daily usage:', error)
      return {
        date: date || new Date().toISOString().split('T')[0],
        total_cost: 0,
        total_tokens: 0,
        models_used: []
      }
    }
  })

  // Get monthly usage statistics
  ipcMain.handle('get-monthly-usage', async (_, year: number, month: number) => {
    console.log('Main: get-monthly-usage called with', year, month)
    try {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`
      const endDate = new Date(year, month, 0).toISOString().split('T')[0] // Last day of month
      return await getUsageStats(startDate, endDate)
    } catch (error) {
      console.error('Error getting monthly usage:', error)
      return {
        total_cost: 0,
        total_tokens: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_creation_tokens: 0,
        total_cache_read_tokens: 0,
        total_sessions: 0,
        total_requests: 0,
        by_model: [],
        by_date: [],
        by_project: []
      }
    }
  })

  // Get project usage statistics
  ipcMain.handle('get-project-usage', async (_, projectPath: string) => {
    console.log('Main: get-project-usage called with', projectPath)
    try {
      const stats = await getUsageStats(undefined, undefined, projectPath)
      return (
        stats.by_project[0] || {
          project_path: projectPath,
          project_name: getProjectName(projectPath),
          total_cost: 0,
          total_tokens: 0,
          session_count: 0,
          last_used: new Date().toISOString()
        }
      )
    } catch (error) {
      console.error('Error getting project usage:', error)
      return {
        project_path: projectPath,
        project_name: getProjectName(projectPath),
        total_cost: 0,
        total_tokens: 0,
        session_count: 0,
        last_used: new Date().toISOString()
      }
    }
  })

  // Export usage data
  ipcMain.handle(
    'export-usage-data',
    async (
      _,
      {
        startDate,
        endDate,
        format
      }: {
        startDate?: string
        endDate?: string
        format: 'json' | 'csv'
      }
    ) => {
      console.log('Main: export-usage-data called with', { startDate, endDate, format })
      try {
        const stats = await getUsageStats(startDate, endDate)

        if (format === 'csv') {
          return exportToCSV(stats)
        } else {
          return JSON.stringify(stats, null, 2)
        }
      } catch (error) {
        console.error('Error exporting usage data:', error)
        throw new Error('Failed to export usage data')
      }
    }
  )

  // Clear usage data
  ipcMain.handle('clear-usage-data', async (_, beforeDate?: string) => {
    console.log('Main: clear-usage-data called with', beforeDate)
    try {
      await clearUsageData(beforeDate)
      return 'Usage data cleared successfully'
    } catch (error) {
      console.error('Error clearing usage data:', error)
      throw new Error('Failed to clear usage data')
    }
  })

  // Get session statistics (summary of current usage)
  ipcMain.handle(
    'get-session-stats',
    async (_, since?: string, until?: string, order?: 'asc' | 'desc') => {
      console.log('Main: get-session-stats called with', { since, until, order })
      try {
        // Get usage stats for the specified date range
        const stats = await getUsageStats(since, until)

        // Return project usage data sorted by the specified order
        const projectUsage = stats.by_project || []

        if (order === 'asc') {
          projectUsage.sort((a, b) => a.total_cost - b.total_cost)
        } else {
          projectUsage.sort((a, b) => b.total_cost - a.total_cost)
        }

        return projectUsage
      } catch (error) {
        console.error('Error getting session stats:', error)
        return []
      }
    }
  )
}

/**
 * Get usage statistics from JSONL files
 */
async function getUsageStats(
  startDate?: string,
  endDate?: string,
  projectPath?: string
): Promise<UsageStats> {
  const claudeDir = join(homedir(), '.claude', 'projects')

  try {
    await fs.access(claudeDir)
  } catch {
    // Directory doesn't exist
    return createEmptyStats()
  }

  const entries: UsageEntry[] = []
  const sessionIds = new Set<string>()

  // Debug: log date filtering
  if (startDate || endDate) {
    console.log('Date filtering active:', { startDate, endDate })
  }

  // Find all JSONL files
  const pattern = join(claudeDir, '**', '*.jsonl')
  const files = await glob(pattern.replace(/\\/g, '/'))

  for (const file of files) {
    try {
      // Extract project path from file location
      const fileProjectPath = extractProjectPath(file)

      // Filter by project if specified
      if (projectPath && fileProjectPath !== projectPath) {
        continue
      }

      const content = await fs.readFile(file, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())

      for (const line of lines) {
        try {
          const json = JSON.parse(line)
          const entry = parseUsageEntry(json, fileProjectPath)

          if (entry) {
            // Filter by date range if specified
            if (startDate) {
              const entryDate = entry.timestamp.split('T')[0]
              if (entryDate < startDate) continue
            }
            if (endDate) {
              const entryDate = entry.timestamp.split('T')[0]
              if (entryDate > endDate) continue
            }

            entries.push(entry)
            sessionIds.add(entry.session_id)
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } catch (error) {
      console.warn('Failed to read file:', file, error)
    }
  }

  const stats = calculateStats(entries, sessionIds)

  // Debug: log filtered results
  if (startDate || endDate) {
    console.log('Filtered stats:', {
      totalEntries: entries.length,
      totalSessions: sessionIds.size,
      totalCost: stats.total_cost,
      dateRange: { startDate, endDate }
    })
  }

  return stats
}

/**
 * Get usage for a specific session
 */
async function getSessionUsage(sessionId: string): Promise<UsageEntry[]> {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const entries: UsageEntry[] = []

  try {
    // Find the session file
    const pattern = join(claudeDir, '**', `${sessionId}.jsonl`)
    const files = await glob(pattern.replace(/\\/g, '/'))

    for (const file of files) {
      try {
        const fileProjectPath = extractProjectPath(file)
        const content = await fs.readFile(file, 'utf-8')
        const lines = content.split('\n').filter((line) => line.trim())

        for (const line of lines) {
          try {
            const json = JSON.parse(line)
            const entry = parseUsageEntry(json, fileProjectPath)
            if (entry) {
              entries.push(entry)
            }
          } catch {
            // Skip invalid JSON lines
          }
        }
      } catch (error) {
        console.warn('Failed to read session file:', file, error)
      }
    }
  } catch (error) {
    console.warn('Failed to find session files:', error)
  }

  return entries
}

/**
 * Parse a usage entry from JSONL
 */
function parseUsageEntry(json: any, projectPath: string): UsageEntry | null {
  // Only process assistant messages with usage data
  const messageType = json.type || json.message_type || undefined
  if (messageType !== 'assistant') return null

  // Look for usage data in the JSON
  const usage = json.usage || (json.message && json.message.usage)
  if (!usage) return null

  const model = json.model || (json.message && json.message.model) || 'unknown'

  // Skip synthetic messages - they don't represent real API calls
  if (model === '<synthetic>') return null

  const sessionId = json.session_id || json.sessionId || 'unknown'
  // requestId is at the top level of the JSON entry, not inside message
  const requestId = json.requestId || json.request_id || json.message_id || undefined

  const inputTokens = usage.input_tokens || 0
  const outputTokens = usage.output_tokens || 0
  const cacheCreationTokens = usage.cache_creation_input_tokens || 0
  const cacheReadTokens = usage.cache_read_input_tokens || 0

  // Calculate cost
  const cost =
    json.cost ||
    json.costUSD ||
    calculateCost(model, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)

  return {
    timestamp: json.timestamp || new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
    cost,
    session_id: sessionId,
    project_path: projectPath,
    request_id: requestId,
    message_type: messageType
  }
}

/**
 * Calculate cost based on model and token usage
 */
function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number
): number {
  const modelKey = model.toLowerCase().replace(/-/g, '')
  const pricing = PRICING[modelKey as keyof typeof PRICING]

  // Return 0 cost for unknown models to avoid incorrect estimations
  if (!pricing) {
    console.warn(`Unknown model: ${model}, setting cost to $0`)
    return 0
  }

  const inputCost = (inputTokens / 1000000) * pricing.input
  const outputCost = (outputTokens / 1000000) * pricing.output
  const cacheWriteCost = (cacheCreationTokens / 1000000) * pricing.cache_write
  const cacheReadCost = (cacheReadTokens / 1000000) * pricing.cache_read

  return inputCost + outputCost + cacheWriteCost + cacheReadCost
}

/**
 * Calculate statistics from usage entries
 */
function calculateStats(entries: UsageEntry[], sessionIds: Set<string>): UsageStats {
  const modelStats = new Map<string, ModelUsage>()
  const dateStats = new Map<string, DailyUsage>()
  const projectStats = new Map<string, ProjectUsage>()
  const uniqueRequestIds = new Set<string>()
  const processedRequestIds = new Set<string>()

  let totalCost = 0
  let totalTokens = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheCreationTokens = 0
  let totalCacheReadTokens = 0

  for (const entry of entries) {
    // Skip duplicate request IDs to avoid counting the same request multiple times
    if (entry.request_id) {
      if (processedRequestIds.has(entry.request_id)) {
        continue // Skip this entry as it's a duplicate
      }
      processedRequestIds.add(entry.request_id)
      uniqueRequestIds.add(entry.request_id)
    }

    // Update totals
    totalCost += entry.cost
    totalInputTokens += entry.input_tokens
    totalOutputTokens += entry.output_tokens
    totalCacheCreationTokens += entry.cache_creation_tokens
    totalCacheReadTokens += entry.cache_read_tokens
    totalTokens +=
      entry.input_tokens +
      entry.output_tokens +
      entry.cache_creation_tokens +
      entry.cache_read_tokens

    // Update model stats
    if (!modelStats.has(entry.model)) {
      modelStats.set(entry.model, {
        model: entry.model,
        total_cost: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        session_count: 0,
        request_count: 0
      })
    }
    const modelStat = modelStats.get(entry.model)!
    modelStat.total_cost += entry.cost
    modelStat.input_tokens += entry.input_tokens
    modelStat.output_tokens += entry.output_tokens
    modelStat.cache_creation_tokens += entry.cache_creation_tokens
    modelStat.cache_read_tokens += entry.cache_read_tokens
    modelStat.total_tokens +=
      entry.input_tokens +
      entry.output_tokens +
      entry.cache_creation_tokens +
      entry.cache_read_tokens

    // Update date stats
    const date = entry.timestamp.split('T')[0]
    if (!dateStats.has(date)) {
      dateStats.set(date, {
        date,
        total_cost: 0,
        total_tokens: 0,
        models_used: []
      })
    }
    const dateStat = dateStats.get(date)!
    dateStat.total_cost += entry.cost
    dateStat.total_tokens +=
      entry.input_tokens +
      entry.output_tokens +
      entry.cache_creation_tokens +
      entry.cache_read_tokens
    if (!dateStat.models_used.includes(entry.model)) {
      dateStat.models_used.push(entry.model)
    }

    // Update project stats
    if (!projectStats.has(entry.project_path)) {
      projectStats.set(entry.project_path, {
        project_path: entry.project_path,
        project_name: getProjectName(entry.project_path),
        total_cost: 0,
        total_tokens: 0,
        session_count: 0,
        request_count: 0,
        last_used: entry.timestamp
      })
    }
    const projectStat = projectStats.get(entry.project_path)!
    projectStat.total_cost += entry.cost
    projectStat.total_tokens +=
      entry.input_tokens +
      entry.output_tokens +
      entry.cache_creation_tokens +
      entry.cache_read_tokens
    if (entry.timestamp > projectStat.last_used) {
      projectStat.last_used = entry.timestamp
    }
  }

  // Count sessions and requests per model and project
  const sessionsByModel = new Map<string, Set<string>>()
  const sessionsByProject = new Map<string, Set<string>>()
  const requestsByModel = new Map<string, Set<string>>()
  const requestsByProject = new Map<string, Set<string>>()

  // Process ALL entries to count sessions and requests
  // We need to count from the original entries, not the deduplicated ones
  for (const entry of entries) {
    // Count sessions (always count, as different requests can belong to same session)
    if (!sessionsByModel.has(entry.model)) {
      sessionsByModel.set(entry.model, new Set())
    }
    sessionsByModel.get(entry.model)!.add(entry.session_id)

    if (!sessionsByProject.has(entry.project_path)) {
      sessionsByProject.set(entry.project_path, new Set())
    }
    sessionsByProject.get(entry.project_path)!.add(entry.session_id)

    // Count unique requests (only if request_id exists)
    if (entry.request_id) {
      if (!requestsByModel.has(entry.model)) {
        requestsByModel.set(entry.model, new Set())
      }
      requestsByModel.get(entry.model)!.add(entry.request_id)

      if (!requestsByProject.has(entry.project_path)) {
        requestsByProject.set(entry.project_path, new Set())
      }
      requestsByProject.get(entry.project_path)!.add(entry.request_id)
    }
  }

  // Update session and request counts
  for (const [model, sessions] of sessionsByModel) {
    const modelStat = modelStats.get(model)
    if (modelStat) {
      modelStat.session_count = sessions.size
      modelStat.request_count = requestsByModel.get(model)?.size || 0
    }
  }

  for (const [projectPath, sessions] of sessionsByProject) {
    const projectStat = projectStats.get(projectPath)
    if (projectStat) {
      projectStat.session_count = sessions.size
      projectStat.request_count = requestsByProject.get(projectPath)?.size || 0
    }
  }

  // Calculate API request count
  // If we have request IDs, use unique count; otherwise use entry count
  const totalRequests = uniqueRequestIds.size > 0 ? uniqueRequestIds.size : entries.length

  return {
    total_cost: totalCost,
    total_tokens: totalTokens,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    total_cache_creation_tokens: totalCacheCreationTokens,
    total_cache_read_tokens: totalCacheReadTokens,
    total_sessions: sessionIds.size,
    total_requests: totalRequests,
    by_model: Array.from(modelStats.values()).sort((a, b) => b.total_cost - a.total_cost),
    by_date: Array.from(dateStats.values()).sort((a, b) => a.date.localeCompare(b.date)),
    by_project: Array.from(projectStats.values()).sort((a, b) => b.total_cost - a.total_cost)
  }
}

/**
 * Decode project path from encoded format
 */
function decodeProjectPath(encoded: string): string {
  // Check if this looks like a Windows path with drive letter (e.g., "C--Users-...")
  if (encoded.match(/^[A-Z]--/)) {
    // Windows path with drive letter
    const driveLetter = encoded.charAt(0)
    const pathPart = encoded.substring(3) // Skip "X--"
    return `${driveLetter}:\\${pathPart.replace(/-/g, '\\')}`
  } else {
    // Unix-like path (macOS/Linux)
    return encoded.replace(/-/g, '/')
  }
}

/**
 * Extract project path from file path
 */
function extractProjectPath(filePath: string): string {
  const claudeDir = join(homedir(), '.claude', 'projects')
  const relativePath = filePath.replace(claudeDir + '/', '')
  const parts = relativePath.split('/')
  const encodedPath = parts[0] || 'unknown'
  // Decode the project path from encoded format (e.g., "-Users-haleclipse-WorkSpace-" to "/Users/haleclipse/WorkSpace/")
  return decodeProjectPath(encodedPath)
}

/**
 * Get project name from path
 */
function getProjectName(projectPath: string): string {
  // If the path is still encoded (shouldn't be after extractProjectPath), decode it first
  const decodedPath =
    projectPath.includes('-') && !projectPath.includes('/')
      ? decodeProjectPath(projectPath)
      : projectPath
  const parts = decodedPath.split('/')
  return parts[parts.length - 1] || decodedPath
}

/**
 * Create empty stats object
 */
function createEmptyStats(): UsageStats {
  return {
    total_cost: 0,
    total_tokens: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    total_sessions: 0,
    total_requests: 0,
    by_model: [],
    by_date: [],
    by_project: []
  }
}

/**
 * Export stats to CSV format
 */
function exportToCSV(stats: UsageStats): string {
  const lines = [
    'Date,Model,Project,Cost,Tokens,Input Tokens,Output Tokens,Cache Creation,Cache Read'
  ]

  // This is a simplified CSV export - you could expand this based on needs
  for (const modelUsage of stats.by_model) {
    lines.push(
      `,,${modelUsage.model},$${modelUsage.total_cost.toFixed(4)},${modelUsage.total_tokens},${modelUsage.input_tokens},${modelUsage.output_tokens},${modelUsage.cache_creation_tokens},${modelUsage.cache_read_tokens}`
    )
  }

  return lines.join('\n')
}

/**
 * Clear usage data (placeholder - actual implementation would depend on how data is stored)
 */
async function clearUsageData(beforeDate?: string): Promise<void> {
  // In a real implementation, you would delete JSONL files or entries before the specified date
  // For now, this is a placeholder
  console.log('Clear usage data before:', beforeDate)
}
