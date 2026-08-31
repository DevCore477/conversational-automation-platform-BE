import { In } from 'typeorm';

import { CallRecordService } from './call-record.service';
import type { CallRecord } from '../../models/calls/call-record.entity';

/**
 * markOrphanedActiveCallsFailed() runs once at process startup and reconciles any call left in a
 * non-terminal DB status by a previous process's death — see the method's own doc for why that
 * inference is safe. Covered with a mocked repository, not a live database: this method is
 * deliberately never exercised against a real DB in this repo's tests, because a bug in its WHERE
 * clause would mark a genuinely in-progress call FAILED — that risk is unacceptable to take on
 * even in a disposable test database, let alone by accident against a shared one.
 */
describe('CallRecordService.markOrphanedActiveCallsFailed', () => {
  function makeOrphan(overrides: Partial<CallRecord> = {}): CallRecord {
    return {
      callSid: 'CA_orphan_1',
      status: 'active',
      metadata: { callType: 'outbound' },
      ...overrides,
    } as CallRecord;
  }

  function buildService(orphans: CallRecord[]) {
    const updateMock = jest.fn().mockResolvedValue({ affected: 1 });
    const findMock = jest.fn().mockResolvedValue(orphans);
    const repo = { find: findMock, update: updateMock } as unknown as ConstructorParameters<
      typeof CallRecordService
    >[0];
    const service = new CallRecordService(repo);
    return { service, updateMock, findMock };
  }

  it('does nothing and returns 0 when there are no non-terminal rows', async () => {
    const { service, updateMock, findMock } = buildService([]);

    const count = await service.markOrphanedActiveCallsFailed();

    expect(count).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(findMock).toHaveBeenCalledWith({
      where: { status: In(['initiating', 'active']) },
    });
  });

  it('marks every non-terminal row FAILED, preserving existing metadata and recording provenance', async () => {
    const orphan = makeOrphan({
      callSid: 'CA_orphan_1',
      status: 'active',
      metadata: { callType: 'outbound', flowId: 'flow-1' },
    });
    const { service, updateMock } = buildService([orphan]);

    const count = await service.markOrphanedActiveCallsFailed();

    expect(count).toBe(1);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [where, patch] = updateMock.mock.calls[0] as [
      { callSid: string },
      Partial<CallRecord> & { metadata: Record<string, unknown> },
    ];
    expect(where).toEqual({ callSid: 'CA_orphan_1' });
    expect(patch.status).toBe('failed');
    expect(patch.completedAt).toBeInstanceOf(Date);
    expect(patch.updatedAt).toBeInstanceOf(Date);
    // Original metadata survives — this must never silently drop existing fields.
    expect(patch.metadata.callType).toBe('outbound');
    expect(patch.metadata.flowId).toBe('flow-1');
    // Provenance recorded so a human debugging this later can tell it apart from a real failure.
    expect(patch.metadata.orphanedOnRestart).toBe(true);
    expect(patch.metadata.orphanedFromStatus).toBe('active');
    expect(typeof patch.metadata.orphanedAt).toBe('string');
  });

  it('processes every orphaned row independently — one row is never skipped because of another', async () => {
    const orphans = [
      makeOrphan({ callSid: 'CA_1', status: 'initiating' }),
      makeOrphan({ callSid: 'CA_2', status: 'active' }),
      makeOrphan({ callSid: 'CA_3', status: 'active' }),
    ];
    const { service, updateMock } = buildService(orphans);

    const count = await service.markOrphanedActiveCallsFailed();

    expect(count).toBe(3);
    expect(updateMock).toHaveBeenCalledTimes(3);
    const updatedCallSids = (updateMock.mock.calls as [{ callSid: string }, unknown][]).map(
      ([where]) => where.callSid,
    );
    expect(updatedCallSids).toEqual(['CA_1', 'CA_2', 'CA_3']);
  });
});
