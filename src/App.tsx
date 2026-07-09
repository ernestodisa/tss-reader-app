import { ImportDropzone } from './components/ImportDropzone';
import { Library } from './components/Library';
import { ReaderView } from './components/ReaderView';
import { useDocument } from './hooks/useDocument';

export default function App() {
  const { doc } = useDocument();

  return (
    <div className="app">
      <header className="app-header">
        <h1>📖 Reader</h1>
      </header>
      <main className="app-main">
        {doc ? (
          <ReaderView />
        ) : (
          <>
            <ImportDropzone />
            <Library />
          </>
        )}
      </main>
    </div>
  );
}
