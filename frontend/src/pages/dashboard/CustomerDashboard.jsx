import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../supabaseClient';
import { apiFetch } from '../../lib/api';
import JobList from '../../components/JobList';

const SAMPLE_PAYLOAD = `{
  "invoice_number": "INV-001",
  "customer_name": "Acme Corp",
  "amount": 5000,
  "notes": "Generated from the customer dashboard"
}`;

export default function CustomerDashboard() {
  const { user, signOut } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [pricing, setPricing] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [templateId, setTemplateId] = useState('');
  const [format, setFormat] = useState('PDF');
  const [payloadText, setPayloadText] = useState(SAMPLE_PAYLOAD);
  const [busy, setBusy] = useState(false);
  const [busyJobId, setBusyJobId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadJobs = async () => {
    const { data } = await supabase
      .from('document_jobs')
      .select('*')
      .order('created_at', { ascending: false });
    setJobs(data ?? []);
  };

  useEffect(() => {
    supabase
      .from('templates')
      .select('id, name')
      .eq('is_active', true)
      .then(({ data }) => {
        setTemplates(data ?? []);
        if (data?.[0]) setTemplateId(data[0].id);
      });
    supabase
      .from('pricing_rules')
      .select('format, base_price, currency')
      .then(({ data }) => setPricing(data ?? []));
    loadJobs();
  }, []);

  const priceOf = (f) => pricing.find((p) => p.format === f);

  const createJob = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      let payload;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw new Error('Payload must be valid JSON');
      }
      const { job } = await apiFetch('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ template_id: templateId, requested_format: format, payload }),
      });
      setNotice(`Job created — charged ₹${job.total_charged} (payment: ${job.payment_status}). Now hit Generate.`);
      await loadJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (id) => {
    setError('');
    setBusyJobId(id);
    try {
      await apiFetch(`/api/jobs/${id}/generate`, { method: 'POST' });
      await loadJobs();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyJobId(null);
    }
  };

  const download = async (id) => {
    setError('');
    try {
      const { url } = await apiFetch(`/api/jobs/${id}/download`);
      window.open(url, '_blank');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="max-w-4xl mx-auto mt-10 p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Customer Dashboard</h1>
        <button onClick={signOut} className="text-sm text-red-600 underline">Sign out</button>
      </div>
      <p className="text-gray-600 text-sm">Signed in as {user?.email}</p>

      <form onSubmit={createJob} className="mt-6 p-4 border rounded bg-gray-50 space-y-4">
        <h2 className="font-semibold">New document</h2>
        {error && <p className="text-red-600 text-sm">{error}</p>}
        {notice && <p className="text-green-700 text-sm">{notice}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium">Template</label>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full p-2 border rounded bg-white"
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium">Format</label>
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              className="w-full p-2 border rounded bg-white"
            >
              {pricing.map((p) => (
                <option key={p.format} value={p.format}>
                  {p.format} — ₹{p.base_price}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy || !templateId}
              className="w-full bg-blue-600 text-white p-2 rounded font-semibold disabled:opacity-50"
            >
              {busy ? 'Creating…' : `Create job (₹${priceOf(format)?.base_price ?? '—'})`}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium">Payload (JSON)</label>
          <textarea
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            rows={7}
            className="w-full p-2 border rounded font-mono text-xs"
          />
        </div>
      </form>

      <h2 className="font-semibold mt-8">My documents</h2>
      <JobList jobs={jobs} onGenerate={generate} onDownload={download} busyId={busyJobId} />
    </div>
  );
}
