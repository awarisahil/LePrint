import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { apiFetch } from '../../lib/api';

const fmt = (n) => `₹${Number(n).toFixed(2)}`;
const FILTERS = ['REQUESTED', 'APPROVED', 'PAID', 'REJECTED', 'ALL'];

const STATUS_STYLES = {
  REQUESTED: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-blue-100 text-blue-800',
  PAID: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
};

export default function AdminDashboard() {
  const { user, signOut } = useAuth();
  const [status, setStatus] = useState('REQUESTED');
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [notes, setNotes] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = status === 'ALL' ? '' : `?status=${status}`;
      const { payouts: list } = await apiFetch(`/api/admin/payouts${query}`);
      setPayouts(list);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id, decision) => {
    setError('');
    setNotice('');
    setBusyId(id);
    try {
      await apiFetch(`/api/admin/payouts/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, admin_notes: notes[id]?.trim() || null }),
      });
      setNotice(`Payout ${decision.toLowerCase()} — vendor wallet updated automatically.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const pending = payouts.filter((p) => p.status === 'REQUESTED');
  const pendingTotal = pending.reduce((sum, p) => sum + Number(p.amount), 0);

  return (
    <div className="max-w-5xl mx-auto mt-10 p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <button onClick={signOut} className="text-sm text-red-600 underline">Sign out</button>
      </div>
      <p className="text-gray-600 text-sm">Signed in as {user?.email}</p>

      {error && <p className="text-red-600 text-sm mt-3">{error}</p>}
      {notice && <p className="text-green-700 text-sm mt-3">{notice}</p>}

      <div className="flex flex-wrap items-center gap-2 mt-6">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setStatus(f)}
            className={`px-3 py-1 rounded text-sm font-medium border ${
              status === f ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-700'
            }`}
          >
            {f === 'ALL' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
          </button>
        ))}
        {status === 'REQUESTED' && !loading && (
          <span className="ml-auto text-sm text-gray-600">
            {pending.length} pending · total {fmt(pendingTotal)}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-gray-500 text-sm mt-6">Loading…</p>
      ) : payouts.length === 0 ? (
        <p className="text-gray-500 text-sm mt-6">No {status === 'ALL' ? '' : status.toLowerCase() + ' '}payout requests.</p>
      ) : (
        <table className="w-full text-sm mt-4 border rounded">
          <thead>
            <tr className="text-left border-b bg-gray-50">
              <th className="p-2">Requested</th>
              <th className="p-2">Vendor</th>
              <th className="p-2">Amount</th>
              <th className="p-2">Status</th>
              <th className="p-2 w-56">Admin notes</th>
              <th className="p-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {payouts.map((p) => (
              <tr key={p.id} className="border-b align-top">
                <td className="p-2 whitespace-nowrap">{new Date(p.created_at).toLocaleString()}</td>
                <td className="p-2">
                  {p.vendor?.email ?? '—'}
                  {p.vendor?.full_name && <div className="text-xs text-gray-500">{p.vendor.full_name}</div>}
                </td>
                <td className="p-2 font-medium">{fmt(p.amount)}</td>
                <td className="p-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[p.status] ?? 'bg-gray-100'}`}>
                    {p.status}
                  </span>
                  {p.admin_notes && <div className="text-xs text-gray-500 mt-1">{p.admin_notes}</div>}
                </td>
                <td className="p-2">
                  <input
                    type="text"
                    value={notes[p.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                    placeholder="Note to vendor (optional)"
                    disabled={p.status !== 'REQUESTED'}
                    className="w-full p-1 border rounded text-xs disabled:bg-gray-100"
                  />
                </td>
                <td className="p-2">
                  {p.status === 'REQUESTED' ? (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => decide(p.id, 'APPROVED')}
                        disabled={busyId === p.id}
                        className="px-2 py-1 rounded text-xs font-medium bg-blue-600 text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => decide(p.id, 'PAID')}
                        disabled={busyId === p.id}
                        className="px-2 py-1 rounded text-xs font-medium bg-green-600 text-white disabled:opacity-50"
                      >
                        Mark paid
                      </button>
                      <button
                        onClick={() => decide(p.id, 'REJECTED')}
                        disabled={busyId === p.id}
                        className="px-2 py-1 rounded text-xs font-medium bg-red-600 text-white disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">decided</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* TODO: revenue stats, vendor management (commission rates), pricing editor */}
    </div>
  );
}
