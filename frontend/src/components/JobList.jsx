const STATUS_STYLES = {
  PENDING: 'bg-yellow-100 text-yellow-800',
  PROCESSING: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  FAILED: 'bg-red-100 text-red-800',
};

export default function JobList({ jobs, onGenerate, onDownload, busyId, showCut = false }) {
  if (!jobs.length) {
    return <p className="text-gray-500 text-sm mt-4">No documents yet — create your first one above.</p>;
  }

  return (
    <table className="w-full text-sm mt-4 border rounded">
      <thead>
        <tr className="text-left border-b bg-gray-50">
          <th className="p-2">Created</th>
          <th className="p-2">Template</th>
          <th className="p-2">Format</th>
          <th className="p-2">Charged</th>
          {showCut && <th className="p-2">Your cut</th>}
          <th className="p-2">Status</th>
          <th className="p-2">Actions</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.id} className="border-b">
            <td className="p-2 whitespace-nowrap">{new Date(job.created_at).toLocaleString()}</td>
            <td className="p-2">{job.template_id}</td>
            <td className="p-2">{job.requested_format}</td>
            <td className="p-2">₹{job.total_charged}</td>
            {showCut && <td className="p-2 text-green-700">{job.vendor_id ? `₹${job.vendor_cut}` : '—'}</td>}
            <td className="p-2">
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[job.status] ?? 'bg-gray-100'}`}>
                {job.status}
              </span>
            </td>
            <td className="p-2 space-x-3">
              {['PENDING', 'FAILED'].includes(job.status) && (
                <button
                  onClick={() => onGenerate(job.id)}
                  disabled={busyId === job.id}
                  className="text-blue-600 underline disabled:opacity-50"
                >
                  {busyId === job.id ? 'Generating…' : job.status === 'FAILED' ? 'Retry' : 'Generate'}
                </button>
              )}
              {job.status === 'COMPLETED' && (
                <button onClick={() => onDownload(job.id)} className="text-blue-600 underline">
                  Download
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
