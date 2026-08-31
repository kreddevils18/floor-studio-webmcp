import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { ActivityEvent, ChangeSet, HumanRequest, PreviewAsset, PreviewTicket, ProjectDocumentV1, RevisionRecord } from '../domain/model'

interface FloorStudioDb extends DBSchema {
  settings: { key: string; value: string }
  projects: { key: string; value: ProjectDocumentV1 }
  revisions: { key: string; value: RevisionRecord; indexes: { byProject: string } }
  drafts: { key: string; value: ChangeSet; indexes: { byProject: string } }
  requests: { key: string; value: HumanRequest; indexes: { byProject: string } }
  activity: { key: string; value: ActivityEvent; indexes: { byProject: string } }
  tickets: { key: string; value: PreviewTicket; indexes: { byProject: string } }
  previews: { key: string; value: PreviewAsset; indexes: { byProject: string } }
  blobs: { key: string; value: Blob }
}

let databasePromise: Promise<IDBPDatabase<FloorStudioDb>> | null = null

export function database() {
  databasePromise ??= openDB<FloorStudioDb>('floor-studio', 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('projects', { keyPath: 'id' })
        const revisions = db.createObjectStore('revisions', { keyPath: 'id' }); revisions.createIndex('byProject', 'projectId')
        const drafts = db.createObjectStore('drafts', { keyPath: 'id' }); drafts.createIndex('byProject', 'projectId')
        const requests = db.createObjectStore('requests', { keyPath: 'id' }); requests.createIndex('byProject', 'projectId')
        const activity = db.createObjectStore('activity', { keyPath: 'id' }); activity.createIndex('byProject', 'projectId')
        const tickets = db.createObjectStore('tickets', { keyPath: 'id' }); tickets.createIndex('byProject', 'projectId')
        const previews = db.createObjectStore('previews', { keyPath: 'id' }); previews.createIndex('byProject', 'projectId')
        db.createObjectStore('blobs')
      }
      if (oldVersion < 2) db.createObjectStore('settings')
    },
  })
  return databasePromise
}

export async function clearDatabaseForTests() {
  const db = await database()
  const stores = ['settings', 'projects', 'revisions', 'drafts', 'requests', 'activity', 'tickets', 'previews', 'blobs'] as const
  const tx = db.transaction(stores, 'readwrite')
  await Promise.all(stores.map((store) => tx.objectStore(store).clear()))
  await tx.done
}

export async function saveInitialProject(project: ProjectDocumentV1) {
  const db = await database()
  const tx = db.transaction(['settings', 'projects', 'revisions'], 'readwrite')
  await tx.objectStore('settings').put(project.id, 'activeProjectId')
  await tx.objectStore('projects').put(project)
  await tx.objectStore('revisions').put({ id: `${project.id}:${project.revision}`, projectId: project.id, revision: project.revision, document: project, createdAt: project.updatedAt })
  await tx.done
}

export async function saveBlob(ref: string, blob: Blob) { await (await database()).put('blobs', blob, ref) }
export async function getBlob(ref: string) { return (await database()).get('blobs', ref) }
