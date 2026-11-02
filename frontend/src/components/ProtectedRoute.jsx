import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ role, children }) {
  const { user, role: authRole, loading } = useAuth();

  if (loading) {
    return <div className="p-10 text-center text-gray-500">Loading...</div>;
  }
  if (!user) return <Navigate to="/auth" replace />;
  if (role && authRole !== role) return <Navigate to="/" replace />;
  return children;
}
