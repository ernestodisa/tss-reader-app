import { AppHeader } from './components/AppHeader';
import { Library } from './components/Library';
import { ReaderView } from './components/ReaderView';
import { useDocument } from './hooks/useDocument';

export default function App() {
  const { doc } = useDocument();

  return (
    <div className="app">
      <AppHeader />
      <main className="app-main">
        {/* La biblioteca ya incluye su propio ImportDropzone (spec §Biblioteca);
            no lo dupliques aquí. */}
        {doc ? <ReaderView /> : <Library />}
      </main>
    </div>
  );
}
