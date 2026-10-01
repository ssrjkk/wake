# Contributing to Wake

Thank you for your interest in contributing to Wake. This document explains how to contribute effectively.

## Development Setup

### Prerequisites

- Node.js 20+ and npm
- Python 3.12+
- Git

### Frontend

```bash
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

### Backend

```bash
cd backend
pip install -r requirements.txt
python seed_demo_leaders.py
uvicorn app:app --reload --port 8000
```

Backend runs on `http://localhost:8000` with Swagger docs at `/docs`.

## Running Tests

### Backend

All tests must pass before submitting:

```bash
cd backend
python -m unittest discover -v
python test_db.py
python test_predict_db.py
python test_predict_integration.py
python test_audit_log.py
```

Current test count: 141 tests covering all backend modules.

### Frontend

TypeScript check and build must pass:

```bash
npx tsc --noEmit
npm run build
```

## Code Style

### Python

- Follow PEP 8
- Use type hints where practical
- Write docstrings for modules and functions
- Keep functions focused and small
- No hardcoded secrets — use environment variables

### TypeScript/React

- Strict TypeScript mode enabled
- Functional components with hooks
- Clear component naming
- No `any` types unless absolutely necessary
- No hardcoded secrets — use environment variables

### General

- Write clear commit messages
- Keep commits focused — one logical change per commit
- Update tests when changing behavior
- Update documentation when changing APIs or configuration

## What to Contribute

Good first contributions:

- Bug fixes with test coverage
- Documentation improvements
- Additional test cases
- Performance optimizations with benchmarks
- UI/UX improvements

Before starting large features, open an issue to discuss the approach.

## Submission Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run all tests
5. Commit with clear messages: `git commit -m "Add feature X"`
6. Push to your fork: `git push origin feature/your-feature`
7. Open a pull request

### Pull Request Guidelines

- Describe what changed and why
- Reference any related issues
- Ensure all tests pass
- Ensure build succeeds
- Keep PRs focused — avoid mixing unrelated changes
- Respond to review feedback promptly

## Reporting Issues

When reporting issues, include:

- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Python version, Node version)
- Relevant logs or error messages

## Security

If you find a security vulnerability, do not open a public issue. Email the maintainer directly or use GitHub's private vulnerability reporting feature.

Do not commit:
- API keys or secrets
- Database credentials
- Private keys
- Any sensitive information

All secrets must come from environment variables.

## Questions?

Open an issue for questions about contributing.

---

# Contributing в Wake

Спасибо за интерес к участию в разработке Wake. Этот документ объясняет, как эффективно вносить вклад.

## Настройка среды разработки

### Требования

- Node.js 20+ и npm
- Python 3.12+
- Git

### Фронтенд

```bash
npm install
npm run dev
```

Фронтенд работает на `http://localhost:5173`.

### Бэкенд

```bash
cd backend
pip install -r requirements.txt
python seed_demo_leaders.py
uvicorn app:app --reload --port 8000
```

Бэкенд работает на `http://localhost:8000`, Swagger документация на `/docs`.

## Запуск тестов

### Бэкенд

Все тесты должны проходить перед отправкой:

```bash
cd backend
python -m unittest discover -v
python test_db.py
python test_predict_db.py
python test_predict_integration.py
python test_audit_log.py
```

Текущее количество тестов: 141 тест покрывает все модули бэкенда.

### Фронтенд

TypeScript проверка и сборка должны проходить:

```bash
npx tsc --noEmit
npm run build
```

## Стиль кода

### Python

- Следуйте PEP 8
- Используйте type hints где практично
- Пишите docstrings для модулей и функций
- Держите функции сфокусированными и небольшими
- Никаких захардкоженных секретов — используйте переменные окружения

### TypeScript/React

- Strict TypeScript режим включён
- Функциональные компоненты с hooks
- Понятные имена компонентов
- Никаких `any` типов кроме абсолютно необходимых
- Никаких захардкоженных секретов — используйте переменные окружения

### Общее

- Пишите понятные commit сообщения
- Держите коммиты сфокусированными — одно логическое изменение на коммит
- Обновляйте тесты при изменении поведения
- Обновляйте документацию при изменении API или конфигурации

## Чем можно помочь

Хорошие первые contributions:

- Исправления багов с покрытием тестами
- Улучшения документации
- Дополнительные тесты
- Оптимизации производительности с бенчмарками
- Улучшения UI/UX

Перед началом больших фич откройте issue для обсуждения подхода.

## Процесс отправки

1. Форкните репозиторий
2. Создайте feature branch: `git checkout -b feature/your-feature`
3. Внесите изменения
4. Запустите все тесты
5. Закоммитьте с понятными сообщениями: `git commit -m "Add feature X"`
6. Запушьте в свой форк: `git push origin feature/your-feature`
7. Откройте pull request

### Требования к Pull Request

- Опишите что изменилось и почему
- Ссылайтесь на связанные issues
- Убедитесь что все тесты проходят
- Убедитесь что сборка успешна
- Держите PR сфокусированными — избегайте смешивания несвязанных изменений
- Оперативно отвечайте на review feedback

## Сообщение о проблемах

При сообщении о проблемах включите:

- Понятное описание проблемы
- Шаги для воспроизведения
- Ожидаемое и фактическое поведение
- Детали окружения (ОС, версия Python, версия Node)
- Соответствующие логи или сообщения об ошибках

## Безопасность

Если нашли уязвимость безопасности, не открывайте публичный issue. Напишите мейнтейнеру напрямую или используйте функцию private vulnerability reporting GitHub.

Не коммитьте:
- API ключи или секреты
- Учётные данные баз данных
- Приватные ключи
- Любую чувствительную информацию

Все секреты должны поступать из переменных окружения.

## Вопросы?

Откройте issue для вопросов об участии в разработке.
