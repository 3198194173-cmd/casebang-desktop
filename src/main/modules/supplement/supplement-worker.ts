import { parentPort, workerData } from 'node:worker_threads'
import { analyzeSupplement } from './supplement-engine'
void analyzeSupplement(workerData).then(result => parentPort?.postMessage({ result })).catch(error => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) }))
