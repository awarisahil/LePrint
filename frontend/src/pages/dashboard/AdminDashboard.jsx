import { useAuth } from '../../context/AuthContext';

export default function AdminDashboard() {
  const { user, role, signOut } = useAuth();

  return (
    <div className="max-w-3xl mx-auto mt-16 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin Dashboard</h1>
        <button onClick={signOut} className="text-sm text-red-600 underline">Sign out</button>
      </div>
      <p className="mt-4 text-gray-600">
        Signed in as {user?.email} — role: <span className="font-mono">{role}</span>
      </p>
      {/* TODO: revenue stats, vendor management (commission rates), pricing editor, payout approvals */}
    </div>
  );
}
