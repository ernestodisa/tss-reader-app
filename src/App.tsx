import { AppHeader } from './components/AppHeader';
import { Library } from './components/Library';
import { ReaderView } from './components/ReaderView';
import { UpdateToast } from './components/UpdateToast';
import { useDocument } from './hooks/useDocument';

export default function App() {
  const { doc } = useDocument();

  return (
    <div className="app">
      {/* En el lector (doc abierto), el AppHeader NO se muestra global: lo
          absorbe la barra única del lector (reader-single-header) que fusiona
          logo + acciones con el header del capítulo. Solo en biblioteca se
          muestra como barra global. */}
      {!doc && <AppHeader />}
      <main className="app-main">
        {/* La biblioteca ya incluye su propio ImportDropzone (spec §Biblioteca);
            no lo dupliques aquí. */}
        {doc ? <ReaderView /> : <Library />}
      </main>
      <UpdateToast />
    </div>
  );
}
